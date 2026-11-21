FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8080
EXPOSE 8080
# Probes never touch the database.
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/ping || exit 1
CMD ["node", "src/server.mjs"]
