const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')
const rmrf = require('rimraf')
rmrf.sync('gen')

require('zotero-plugin/copy-assets')
require('zotero-plugin/rdf')
require('zotero-plugin/version')

async function build() {
  await esbuild.build({
    bundle: true,
    format: 'esm',
    target: ['firefox60'],
    entryPoints: [ 'content/zotero-asreview.ts' ],
    banner: { js: 'if (!Zotero.ASReview) {\n' },
    outdir: 'build/content',
    footer: { js: '\n}' },
    external: [
      'zotero/itemTree',
    ]
  })
}

build().catch(err => {
  console.log(err)
  process.exit(1)
})
