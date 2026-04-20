FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY docs/api.md docs/api_rev_260417a.md ./docs/
COPY config.example.json ./config.example.json

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=58002

EXPOSE 58002

CMD ["node", "src/index.js"]

