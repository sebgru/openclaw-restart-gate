FROM node:22-alpine
WORKDIR /app
# Upgrade all packages to pick up latest security patches.
RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*
# Remove npm and its bundled deps — not needed at runtime, avoids Trivy false positives.
RUN rm -rf /usr/local/lib/node_modules/npm
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["node", "-e", "require('http').get({hostname:'127.0.0.1',port:+(process.env.PORT||8080),path:'/healthz'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "src/main.js"]
