FROM node:22-slim
WORKDIR /srv
COPY package.json ./
COPY src ./src
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
# Probes never touch the database.
HEALTHCHECK --interval=30s CMD node -e "fetch('http://localhost:3000/ping').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/app.mjs"]
