FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3005 TZ=Asia/Kathmandu
RUN apk add --no-cache tzdata
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server.js db.js store.js domain.js app.js auth.js ui.js index.html login.html register.html styles.css logo.png ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node .env.example ./
USER node
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3005/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
