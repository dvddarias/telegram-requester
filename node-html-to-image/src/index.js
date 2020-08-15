const puppeteer = require('puppeteer')
const { Cluster } = require('puppeteer-cluster')

const { makeScreenshot } = require('./screenshot.js')

module.exports = async function(options) {
  const {
    html,
    content,
    output,
    url,    
    puppeteerArgs = {},
  } = options

  if (!html && !url) {
    throw Error('You must provide an html property or a url.');
  }
  if (html) options.url = false;

  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: 2,
    puppeteerOptions: { ...puppeteerArgs, headless: true },
  });

  let buffers = []

  await cluster.task(async ({ page, data: { content, output } }) => {
    const buffer = await makeScreenshot(page, { ...options, content, output })

    buffers.push(buffer);
  });

  const shouldBatch = Array.isArray(content)
  const contents = shouldBatch ? content : [{ ...content, output }]

  contents.forEach(content => {
    const { output, ...pageContent } = content
    cluster.queue({ output, content: pageContent })
  })

  await cluster.idle();
  await cluster.close();

  return shouldBatch ? buffers : buffers[0]
}

