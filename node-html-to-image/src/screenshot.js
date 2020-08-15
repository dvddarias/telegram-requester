const handlebars = require('handlebars')

module.exports = {
  makeScreenshot: async function(page, {
    output,
    type,
    quality,
    encoding,
    content,
    html,
    url,
    query = 'body',
    transparent = false,
    waitUntil = 'networkidle0',
  }) {
    let screeshotArgs = {}
    if (type === 'jpeg') {
      screeshotArgs.quality = quality ? quality : 80
    }

    if (html && content) {
      const template = handlebars.compile(html)
      html = template(content)
    }
    if (html) {
      await page.setContent(html, { waitUntil })
    }
    else{
      await page.goto(url, { waitUntil })
    }
    const element = await page.$(query)
    const buffer = await element.screenshot({ path: output, type, omitBackground: transparent, encoding, ...screeshotArgs })

    return buffer
  }
}
