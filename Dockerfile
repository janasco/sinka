FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
ENV PORT=8788 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 8788
CMD ["node", "src/index.js"]
