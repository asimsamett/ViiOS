FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && PLAYWRIGHT_BROWSERS_PATH=/opt/browsers npx playwright install --with-deps chromium
ENV APP_HOST=0.0.0.0 APP_PORT=3180 DATA_DIR=/data PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
RUN mkdir /data && chown node:node /data /app
USER node
EXPOSE 3180
CMD ["node", "server/index.mjs"]
