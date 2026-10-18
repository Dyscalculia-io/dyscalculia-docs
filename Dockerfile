# Docs: the HTML is generated at build time (Node) and served by a small dependency-free Node static server.
# The build reads the published packages (tool reference from dyscalculia-mcp, numbers from dyscalculia-data,
# game catalog from dyscalculia-embed), so it needs the npm registry.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# With a lockfile: reproducible install. Without one (before the first publish): plain install.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/dist ./dist
COPY server.mjs ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server.mjs"]
