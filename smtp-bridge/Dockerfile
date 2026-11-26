FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY healthcheck.js message.js server.js templates.js ./

EXPOSE 1025
USER node
CMD ["node", "server.js"]
