FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8080
EXPOSE 8080
# Liveness only: /health/live answers from the process and never touches Postgres, so an idle
# container lets Neon suspend. /health (database included) is for verify.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/health/live || exit 1
CMD ["node", "src/server.mjs"]
