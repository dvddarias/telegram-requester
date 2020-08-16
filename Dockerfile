# A minimal Docker image with Node and Puppeteer
#
# Initially based upon:
# https://github.com/GoogleChrome/puppeteer/blob/master/docs/troubleshooting.md#running-puppeteer-in-docker

FROM buildkite/puppeteer

WORKDIR /bot
COPY package.json .
COPY package-lock.json .
RUN npm install
COPY index.js .
COPY node-html-to-image ./node-html-to-image

CMD ["node", "index.js"]