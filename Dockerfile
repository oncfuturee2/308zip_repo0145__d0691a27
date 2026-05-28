FROM node:20-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma/
RUN npx prisma generate

COPY tsconfig.json vitest.config.ts ./
COPY src ./src/
RUN npm run build

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DATABASE_URL="file:./dev.db"

RUN npx prisma db push

RUN printf 'node_modules/\ndev.db\n*.sqlite\n*.sqlite3\n*.log\n.DS_Store\ndocker-run-screenshot.png\ndocker-api-smoke.txt\n' > .gitignore \
    && git init \
    && git config user.email "docker@local" \
    && git config user.name "Docker" \
    && git add -A \
    && git commit -m "baseline"

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
