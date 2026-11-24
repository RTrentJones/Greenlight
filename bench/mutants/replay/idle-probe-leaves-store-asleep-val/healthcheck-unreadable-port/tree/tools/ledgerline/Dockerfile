FROM node:22-slim
WORKDIR /srv
COPY package.json ./
COPY src ./src
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:$(printenv PORT)/health" || exit 1
CMD ["node", "src/app.mjs"]
