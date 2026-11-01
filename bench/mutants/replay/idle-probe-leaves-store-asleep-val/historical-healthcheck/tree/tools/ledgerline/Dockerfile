FROM node:22-slim
WORKDIR /srv
COPY package.json ./
COPY src ./src
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
HEALTHCHECK --interval=20s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/app.mjs"]
