FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY agent/mcp.mjs ./agent/mcp.mjs

CMD ["node", "agent/mcp.mjs"]
