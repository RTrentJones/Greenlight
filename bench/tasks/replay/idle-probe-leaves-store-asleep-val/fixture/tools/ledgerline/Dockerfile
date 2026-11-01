FROM node:22-slim
WORKDIR /srv
COPY package.json ./
COPY src ./src
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "src/app.mjs"]
