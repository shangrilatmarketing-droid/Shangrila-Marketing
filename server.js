'use strict';
require('dotenv').config({ quiet: true });
const express = require('express');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');
const {createPostgresStore} = require('./db');
const {COMPANIES, escapeHtml, fail, validTime, money, cleanEmail, validPassword, validatePlans, dateInZone, advanceRecurring} = require('./domain');

async function createApplication(options = {}) {
    const secret = options.secret || process.env.JWT_SECRET;
    if (!secret || secret.length < 32 || secret === 'super_secret_shangrila_key_123') throw new Error('Set JWT_SECRET to a random secret of at least 32 characters.');
    const timeZone = process.env.TZ || 'Asia/Kathmandu';
    dateInZone(new Date(), timeZone);
    const store = options.store || await createPostgresStore(options.database || {});
    const app = express();
    const cookieOptions = {httpOnly:true, sameSite:'lax', secure:process.env.COOKIE_SECURE === 'true', maxAge:7 * 86400000, path:'/'};
    const smtpReady = Boolean(process.env.SMTP_HOST || (process.env.SMTP_USER && process.env.SMTP_PASS));
    const transporter = Object.hasOwn(options, 'transporter') ? options.transporter : smtpReady ? nodemailer.createTransport({
        ...(process.env.SMTP_HOST ? {host:process.env.SMTP_HOST, port:Number(process.env.SMTP_PORT || 587), secure:process.env.SMTP_SECURE === 'true'} : {service:'gmail'}),
        ...(process.env.SMTP_USER ? {auth:{user:process.env.SMTP_USER, pass:process.env.SMTP_PASS}} : {}),
        connectionTimeout:10000, greetingTimeout:10000, socketTimeout:20000, disableFileAccess:true, disableUrlAccess:true
    }) : null;
    app.disable('x-powered-by');
    if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : process.env.TRUST_PROXY);
    app.use((req, res, next) => {
        res.set({'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY', 'Referrer-Policy':'same-origin',
            'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"});
        if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) res.set('Cache-Control','no-store');
        if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin) {
            let origin;
            try { origin = new URL(req.headers.origin); } catch { return res.status(403).json({error:'Invalid request origin.'}); }
            const allowed = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : `${req.protocol}://${req.get('host')}`;
            if (origin.origin !== allowed) return res.status(403).json({error:'Request origin is not allowed.'});
        }
        next();
    });
    app.use(express.json({limit:'8mb'}));
    const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
    const limited = new Map();
    function rateLimit(scope, max, windowMs) {
        return (req, res, next) => {
            const now = Date.now();
            for (const [key, entry] of limited) if (entry.until <= now) limited.delete(key);
            const key = scope + ':' + (req.user?.email || req.ip);
            const entry = limited.get(key) || {count:0, until:now + windowMs};
            entry.count++;
            limited.set(key, entry);
            if (entry.count > max) {res.set('Retry-After', String(Math.ceil((entry.until-now)/1000))); return res.status(429).json({error:'Too many attempts. Please try again later.'});}
            next();
        };
    }
    function requireCurrentUser(users, email, version) {
        const user = users.find(u => u.email === email);
        if (!user || user.isApproved === false || (user.tokenVersion || 0) !== version) fail('Your session has expired or access has been revoked. Please sign in.',401);
        return user;
    }
    const authenticate = asyncRoute(async (req, res, next) => {
        const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('plan_session='));
        const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : cookie?.slice('plan_session='.length);
        if (!token) fail('Please sign in.',401);
        let decoded;
        try { decoded = jwt.verify(token, secret, {algorithms:['HS256']}); }
        catch { fail('Your session has expired. Please sign in.',401); }
        req.sessionVersion = decoded.version || 0;
        req.user = requireCurrentUser(await store.read('users'), decoded.email, req.sessionVersion);
        if (req.headers.authorization) res.cookie('plan_session',token,cookieOptions);
        next();
    });
    function admin(req, res, next) { if (!req.user.isAdmin) fail('Administrator access required.',403); next(); }
    function change(req, work) {
        return store.transaction(async tx => {
            const user = requireCurrentUser(await tx.read('users'), req.user.email, req.sessionVersion);
            return work(tx, user);
        });
    }
    const safeUser = u => ({email:u.email, isAdmin:Boolean(u.isAdmin), isApproved:u.isApproved !== false});
    async function maintainPlans(tx) {
        const plans = await tx.read('database');
        if (advanceRecurring(plans, dateInZone(new Date(),timeZone).date)) await tx.write('database',plans);
        return plans;
    }
    app.get('/health', asyncRoute(async (req,res) => {
        try { await store.health(); res.json({status:'ok',database:'postgresql'}); }
        catch { res.status(503).json({status:'unavailable'}); }
    }));
    app.post('/api/register',rateLimit('register',10,3600000),asyncRoute(async (req,res) => {
        const email = cleanEmail(req.body.email);
        validPassword(req.body.password);
        const password = await bcrypt.hash(req.body.password,12);
        const isAdmin = await store.transaction(async tx => {
            const users = await tx.read('users');
            if (users.some(u => u.email.toLowerCase() === email)) fail('This email is already registered.',409);
            const first = users.length === 0;
            users.push({email,password,isAdmin:first,isApproved:first,tokenVersion:0});
            await tx.write('users',users);
            return first;
        });
        res.status(201).json({success:true,isApproved:isAdmin,message:isAdmin ? 'Account created. You can sign in.' : 'Account created. An administrator must approve it before you can sign in.'});
    }));
    app.post('/api/login',rateLimit('login',30,900000),asyncRoute(async (req,res) => {
        const email = cleanEmail(req.body.email);
        if (typeof req.body.password !== 'string' || Buffer.byteLength(req.body.password)>72) fail('Invalid email or password.');
        const before = (await store.read('users')).find(u => u.email.toLowerCase() === email);
        const ok = before && await bcrypt.compare(req.body.password,before.password);
        const user = (await store.read('users')).find(u => u.email === before?.email);
        if (!ok || !user || user.password !== before.password) fail('Invalid email or password.',401);
        if (user.isApproved === false) fail('Your account is awaiting administrator approval.',403);
        const token = jwt.sign({email:user.email,version:user.tokenVersion || 0},secret,{algorithm:'HS256',expiresIn:'7d'});
        res.cookie('plan_session',token,cookieOptions);
        res.json({success:true,...safeUser(user)});
    }));
    app.post('/api/logout',(req,res) => {res.clearCookie('plan_session',cookieOptions);res.json({success:true});});
    app.get('/api/admin/users',authenticate,admin,asyncRoute(async (req,res) => res.json((await store.read('users')).map(safeUser))));
    app.post('/api/admin/reset-password',authenticate,admin,asyncRoute(async (req,res) => {
        validPassword(req.body.newPassword);
        const email = cleanEmail(req.body.targetEmail);
        const hash = await bcrypt.hash(req.body.newPassword,12);
        await change(req,async (tx,actor) => {
            if (!actor.isAdmin) fail('Administrator access required.',403);
            const users = await tx.read('users');
            const user = users.find(u => u.email.toLowerCase() === email);
            if (!user) fail('User not found.',404);
            user.password=hash; user.tokenVersion=(user.tokenVersion || 0)+1;
            await tx.write('users',users);
        });
        res.json({success:true,message:'Password reset. Existing sessions have been revoked.'});
    }));
    for (const [route,field] of [['toggle-role','isAdmin'],['toggle-approval','isApproved']]) {
        app.post('/api/admin/'+route,authenticate,admin,asyncRoute(async (req,res) => {
            const email = cleanEmail(req.body.targetEmail);
            const result = await change(req,async (tx,actor) => {
                if (!actor.isAdmin) fail('Administrator access required.',403);
                const users=await tx.read('users');
                const user=users.find(u => u.email.toLowerCase() === email);
                if (!user) fail('User not found.',404);
                if (user.email === actor.email) fail('You cannot change your own role or approval.');
                user[field] = field === 'isApproved' ? user[field] === false : !user[field];
                if (field === 'isApproved' && !user[field]) user.tokenVersion=(user.tokenVersion || 0)+1;
                await tx.write('users',users);
                return safeUser(user);
            });
            res.json({success:true,message:'Account updated.',...result});
        }));
    }
    async function settings(user, reader=store) {
        return {annualBudget:await reader.read('budget'),emailNotificationsEnabled:user.emailNotificationsEnabled !== false,
            emailNotificationTime:user.emailNotificationTime || '10:00',emailConfigured:Boolean(transporter),timeZone,...safeUser(user)};
    }
    app.get('/api/user/settings',authenticate,asyncRoute(async (req,res) => res.json(await settings(req.user))));
    app.post('/api/user/settings',authenticate,asyncRoute(async (req,res) => {
        const {annualBudget,emailNotificationsEnabled,emailNotificationTime}=req.body;
        if (emailNotificationsEnabled !== undefined && typeof emailNotificationsEnabled !== 'boolean') fail('Invalid email preference.');
        if (emailNotificationTime !== undefined && !validTime(emailNotificationTime)) fail('Enter a valid digest time.');
        const result=await change(req,async (tx,actor) => {
            if (annualBudget !== undefined) {
                if (!actor.isAdmin) fail('Only administrators can edit budgets.',403);
                if (!annualBudget || typeof annualBudget !== 'object' || Array.isArray(annualBudget)) fail('Invalid budget.');
                await tx.write('budget',Object.fromEntries(COMPANIES.map(c => [c,money(annualBudget[c])])));
            }
            const users=await tx.read('users');
            const user=users.find(u => u.email === actor.email);
            if (emailNotificationsEnabled !== undefined) user.emailNotificationsEnabled=emailNotificationsEnabled;
            if (emailNotificationTime !== undefined) user.emailNotificationTime=emailNotificationTime;
            await tx.write('users',users);
            return settings(user,tx);
        });
        res.json({success:true,...result});
    }));
    const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:0,parts:2}});
    app.post('/api/upload',authenticate,rateLimit('upload',30,60000),upload.single('photo'),asyncRoute(async (req,res) => {
        if (!req.file) fail('Choose a photo.');
        const b=req.file.buffer;
        const ext=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
            : b[0]===255 && b[1]===216 && b[2]===255 ? 'jpg'
            : ['GIF87a','GIF89a'].includes(b.subarray(0,6).toString()) ? 'gif'
            : b.subarray(0,4).toString()==='RIFF' && b.subarray(8,12).toString()==='WEBP' ? 'webp' : null;
        if (!ext) fail('Upload a PNG, JPEG, GIF, or WebP image (up to 5 MB).');
        const filename=randomUUID()+'.'+ext;
        await change(req,(tx,user) => tx.putUpload(filename,{png:'image/png',jpg:'image/jpeg',gif:'image/gif',webp:'image/webp'}[ext],b,user.email));
        res.status(201).json({success:true,photoUrl:'/uploads/'+filename});
    }));
    app.get('/uploads/:filename',authenticate,asyncRoute(async (req,res) => {
        if (!/^[\w.-]+\.(png|jpe?g|gif|webp)$/i.test(req.params.filename)) return res.sendStatus(404);
        const photo=await store.getUpload(req.params.filename);
        if (!photo) return res.sendStatus(404);
        res.type(photo.content_type).send(photo.file_data);
    }));
    app.get('/api/plans',authenticate,asyncRoute(async (req,res) => {
        const plans=await change(req,tx => maintainPlans(tx));
        res.set('ETag',store.revision(plans)).json(plans);
    }));
    app.post('/api/plans',authenticate,asyncRoute(async (req,res) => {
        const plans=await change(req,async (tx,user) => {
            const current=await maintainPlans(tx);
            if (!req.get('If-Match')) fail('Reload the app before saving.',428);
            if (req.get('If-Match') !== store.revision(current)) fail('Another teammate changed these plans. The latest version has been loaded; review it and try again.',409);
            const result=validatePlans(req.body,current,user.email);
            const old=new Map(current.map(p => [String(p.id),p]));
            const retained=new Set(result.map(p => p.id));
            if (current.some(p => !retained.has(String(p.id)) && p.status !== 'junk')) fail('Move plans to Junk before permanently deleting them.');
            for (const p of result) if (p.photoUrl && old.get(p.id)?.photoUrl !== p.photoUrl && !await tx.hasUpload(path.basename(p.photoUrl))) fail('The uploaded photo could not be found.');
            advanceRecurring(result,dateInZone(new Date(),timeZone).date);
            await tx.write('database',result);
            return result;
        });
        res.set('ETag',store.revision(plans)).json({success:true,plans});
    }));
    app.get('/api/export-report', authenticate, asyncRoute(async (req, res) => {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Shangrila Tours';
        const sheet = workbook.addWorksheet('Completed Tasks', {views:[{state:'frozen', ySplit:1}]});
        sheet.columns = [
            {header:'Title', key:'title', width:30}, {header:'Description', key:'description', width:45},
            {header:'Company', key:'company', width:25}, {header:'Cost (NPR)', key:'cost', width:22, style:{numFmt:'"NPR "#,##0.00'}},
            {header:'Target Date', key:'date', width:16}, {header:'Time', key:'time', width:12},
            {header:'Added By', key:'createdBy', width:32}, {header:'Completion Date', key:'completedDate', width:20}, {header:'Status', key:'status', width:15}
        ];
        let total = 0;
        for (const p of (await store.read('database')).filter(p => ['completed','archived'].includes(p.status))) {
            const cost = Number(p.cost) || 0;
            total += cost;
            const completedDate = p.completedAt && !Number.isNaN(new Date(p.completedAt).getTime()) ? dateInZone(new Date(p.completedAt), timeZone).date : '';
            sheet.addRow({...p, cost, completedDate});
        }
        sheet.autoFilter = {from:'A1', to:'I' + Math.max(1, sheet.rowCount)};
        sheet.getRow(1).font = {bold:true, color:{argb:'FFFFFFFF'}};
        sheet.getRow(1).fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FF164E63'}};
        sheet.getRow(1).height = 28;
        sheet.addRow({});
        const totalRow = sheet.addRow({company:'TOTAL SPENDING', cost:Math.round(total*100)/100});
        totalRow.font = {bold:true};
        sheet.eachRow(row => {row.alignment = {vertical:'top', wrapText:true};});
        res.set({'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition':'attachment; filename="Completed_Tasks_Report.xlsx"'});
        await workbook.xlsx.write(res);
        res.end();
    }));
    app.post('/api/test-email', authenticate, rateLimit('email', 3, 300000), asyncRoute(async (req, res) => {
        if (!transporter) return res.status(503).json({error:'Email is not configured. Set the SMTP environment variables on the server.'});
        await transporter.sendMail({from:process.env.SMTP_FROM || process.env.SMTP_USER, to:req.user.email,
            subject:'Test notification: Shangrila Tours', text:'Your marketing tracker email notifications are working.'});
        res.json({success:true});
    }));
    for (const name of ['index.html','login.html','register.html','styles.css','app.js','auth.js','ui.js','logo.png']) {
        app.get('/' + name, (req, res) => res.sendFile(path.join(__dirname, name)));
    }
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
    app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));
    app.get('/vendor/lucide.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/lucide/dist/umd/lucide.js')));
    app.use((req, res) => res.status(404).json({error:'Not found.'}));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const status = error instanceof multer.MulterError ? 400 : error.status || 500;
        if (status >= 500) console.error('Request failed:', error.message);
        res.status(status).json({error: error.code === 'LIMIT_FILE_SIZE' ? 'Photos must be no larger than 5 MB.' : status >= 500 ? 'The server could not complete the request. Please try again.' : error.message});
    });
    let digestRunning=false;
    async function runMaintenance(now=new Date()) {
        if (digestRunning) return;
        digestRunning=true;
        try {
            const plans=await store.transaction(tx => maintainPlans(tx));
            if (!transporter) return;
            const local=dateInZone(now,timeZone);
            const today=plans.filter(p => p.date === local.date && (!p.status || p.status === 'pending'));
            if (!today.length) return;
            for (const user of await store.read('users')) {
                if (user.isApproved === false || user.emailNotificationsEnabled === false || (user.emailNotificationTime || '10:00') !== local.time) continue;
                const token=await store.claimDigest(user.email,local.date);
                if (!token) continue;
                const items=today.map(p => `<li><strong>${escapeHtml(p.title)}</strong>${p.time ? ' at '+escapeHtml(p.time) : ''} — ${escapeHtml(p.description)}</li>`).join('');
                try {
                    await transporter.sendMail({from:process.env.SMTP_FROM || process.env.SMTP_USER,to:user.email,
                        subject:`Daily digest: ${today.length} plans for today`,html:`<h2>Shangrila Tours Marketing Tracker</h2><p>Today's team schedule (${escapeHtml(timeZone)}):</p><ul>${items}</ul>`});
                } catch (error) {
                    await store.finishDigest(user.email,local.date,token,false);
                    console.error('Daily digest failed:',error.message);
                    continue;
                }
                // If recording fails after SMTP accepts a message, leave the lease in
                // place; do not immediately retry a delivery that may have succeeded.
                await store.finishDigest(user.email,local.date,token,true);
            }
        } finally {digestRunning=false;}
    }
    return {app,store,runMaintenance,close:() => store.close()};
}
if (require.main === module) {
    createApplication().then(({app,runMaintenance,close}) => {
        const port=Number(process.env.PORT || 3005);
        const server=app.listen(port,'0.0.0.0',() => console.log(`Shangrila Tours Marketing Tracker (PostgreSQL): http://localhost:${port}`));
        const timer=process.env.DISABLE_SCHEDULER === 'true' ? null : setInterval(() => runMaintenance().catch(error => console.error('Maintenance failed:',error.message)),15000);
        function shutdown() {
            clearInterval(timer);
            server.close(() => close().then(() => process.exit(0)).catch(() => process.exit(1)));
            setTimeout(() => process.exit(1),10000).unref();
        }
        process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
    }).catch(error => {console.error('Startup failed:',error.message);process.exitCode=1;});
}
module.exports={createApplication};
