# MCP server (oci lane). Node 24 strips TypeScript types natively, so server.ts runs directly.
FROM node:24-slim
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/server.ts"]
