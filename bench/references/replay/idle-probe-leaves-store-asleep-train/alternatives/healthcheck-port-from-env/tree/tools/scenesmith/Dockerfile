FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8080
EXPOSE 8080
# Liveness only: /health/live answers from the process and never touches Postgres, so an idle
# container lets Neon suspend. /health (database included) is for verify.
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://localhost:' + process.env.PORT + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/server.mjs"]
