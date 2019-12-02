FROM node:13.1.0-alpine3.10

WORKDIR /bot
COPY package.json .
COPY package-lock.json .
RUN npm install
COPY index.js .

CMD ["node", "index.js"]