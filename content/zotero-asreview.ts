declare const Zotero: any
declare const OS: any
declare const ZoteroPane_Local: any
// declare const Components: any
import * as csv from 'papaparse'
import type BluebirdPromise from 'bluebird'
import * as l10n from './l10n'

const ranking_attachment = 'asreview.csv'

const monkey_patch_marker = 'ASReviewMonkeyPatched'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function patch(object, method, patcher) {
  Zotero.debug(`asreview: patching ${method}`)
  if (object[method][monkey_patch_marker]) return
  object[method] = patcher(object[method])
  object[method][monkey_patch_marker] = true
}

class Deferred<ReturnType> {
  public promise: BluebirdPromise<ReturnType>
  public resolve: (v: ReturnType) => void
  public reject: (e: any) => void
  public isPending: () => boolean

  constructor() {
    this.promise = new Zotero.Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    }) as BluebirdPromise<ReturnType>
    for (const op of ['isPending', 'then', 'catch']) {
      this[op] = this.promise[op]?.bind(this.promise)
    }
  }
}

const ready = new Deferred<boolean>()

function celltext(item): string {
  if (!item.isRegularItem()) return ''

  if (ready.promise.isPending()) return '\u231B'
  const collection = ZoteroPane_Local.getSelectedCollection()
  if (!collection) return ''

  const rankings = Zotero.ASReview.ranking[collection.id]
  if (!rankings) return ''
  const ranking = rankings.rank[item.id]

  return typeof ranking === 'undefined' ? '' : `${ranking}`.padStart(5, ' ') // eslint-disable-line @typescript-eslint/no-magic-numbers
}

patch(Zotero.Item.prototype, 'getField', original => function Zotero_Item_prototype_getField(field: string) {
  try {
    if (field === 'asreview') return celltext(this)
  }
  catch (err) {
    Zotero.debug(`asreview monkey-patched getField: ${err.message}`)
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return original.apply(this, arguments) as string // eslint-disable-line prefer-rest-params
})

if (typeof Zotero.ItemTreeView === 'undefined') {
  const itemTree = require('zotero/itemTree')

  patch(itemTree.prototype, 'getColumns', original => function Zotero_ItemTree_prototype_getColumns() {
    const columns = original.apply(this, arguments) // eslint-disable-line prefer-rest-params
    const insertAfter: number = columns.findIndex(column => column.dataKey === 'title')
    columns.splice(insertAfter + 1, 0, {
      dataKey: 'citekey',
      label: l10n.localize('ZoteroPane.column.asreview'),
      flex: '1',
      zoteroPersist: new Set(['width', 'ordinal', 'hidden', 'sortActive', 'sortDirection']),
    })

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return columns
  })

  patch(itemTree.prototype, '_renderCell', original => function Zotero_ItemTree_prototype_renderCell(index, data, col) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    if (col.dataKey !== 'asreview') return original.apply(this, arguments) // eslint-disable-line prefer-rest-params

    const cell = document.createElementNS('http://www.w3.org/1999/xhtml', 'span')
    cell.className = `cell ${col.className}`

    const ranking = celltext(this.getRow(index).ref)
    if (ranking) {
      const text = document.createElementNS('http://www.w3.org/1999/xhtml', 'span')
      text.className = 'cell-text'
      text.innerText = ranking ? `${ranking}` : ''
      cell.append(text)
    }

    return cell
  })
}
else {
  const itemTreeViewWaiting: Record<number, boolean> = {}
  patch(Zotero.ItemTreeView.prototype, 'getCellText', original => function Zotero_ItemTreeView_prototype_getCellText(row: any, col: { id: string }): string {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    if (col.id !== 'zotero-items-column-asreview') return original.apply(this, arguments) // eslint-disable-line prefer-rest-params

    const item = this.getRow(row).ref

    if (ready.promise.isPending()) {
      if (!itemTreeViewWaiting[item.id]) {
        itemTreeViewWaiting[item.id] = true
        ready.promise.then(() => {
          this._treebox.invalidateRow(row)
        })
      }

      return '\u231B'
    }

    return celltext(item)
  })
}

type Ranking = {
  updated: number
  rank: Record<number, number> // itemID -> ranking
}

type ASReviewRow = {
  issn: string
  doi: string
  asreview_ranking: number
}

class ASReview { // tslint:disable-line:variable-name
  public ranking: Record<number, Ranking> = {} // collectionID -> ranking
  public ready: BluebirdPromise<boolean> = ready.promise

  private initialized = false
  private globals: Record<string, any>


  private decoder = new TextDecoder

  get(item: any, field: string): string {
    const prefix = `${field}:`
    return (item.getField(field) as string) || (item.getField('extra') as string)?.split('\n').find((line: string) => line.startsWith(prefix))?.replace(prefix, '') || ''
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async load(globals: Record<string, any>): Promise<void> {
    this.globals = globals

    this.log('load')
    if (this.initialized) return
    this.initialized = true
    this.log('fresh load')
    await Zotero.Schema.schemaUpdatePromise
    this.log('zotero ready')

    const s = new Zotero.Search()
    s.addCondition('title', 'is', ranking_attachment, true)
    s.addCondition('itemType', 'is', 'attachment', true)
    const ids = (await s.search()) || []
    const items = (ids.length ? await Zotero.Items.getAsync(ids) : []).filter(item => !item.parentKey)
    this.log(`startup: ${items.length} rankings`)
    for (const item of items) {
      await this.updateItem(item)
    }

    ready.resolve(true)
  }

  log(msg: string) {
    Zotero.debug(`asreview: ${msg}`)
  }

  async parse(item): Promise<{ updated?: number, rows: ASReviewRow[]}> {
    if (!item || !item.isAttachment()) return { rows: [] }

    const path = item.getFilePath()
    this.log(`parsing ${path}`)
    try {
      const stat = await OS.File.stat(path)
      const content = this.decoder.decode(await OS.File.read(path) as BufferSource)
      const delimiter = csv.parse(content.split('\n')[0]).meta.delimiter // papaparse autodetection is wonky
      const rankings = csv.parse(content, {
        delimiter,
        header: true,
        dynamicTyping: true,
      })
      this.log(`parsing ${path}: ${rankings.data.length} rows`)

      return { updated: stat.lastModificationDate.getTime(), rows: rankings.data }
    }
    catch (err) {
      this.log((err instanceof OS.File.Error && err.becauseNoSuchFile) ? `path ${path} does not exist` : `${path}: ${err.message}`)
    }

    return { rows: [] }
  }

  async updateCollection(collectionID) {
    this.log(`updating collection ${collectionID}`)
    const collection = await Zotero.Collections.getAsync(collectionID)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const ranking = await this.parse(collection ? collection.getChildItems().find(item => item.isAttachment() && item.getField('title') === ranking_attachment) : null)

    if (!ranking.rows.length) {
      delete this.ranking[collectionID]
    }
    else if (this.ranking[collectionID]?.updated !== ranking.updated) {
      this.ranking[collectionID] = {
        updated: ranking.updated,
        rank: {},
      }

      for (const item of collection.getChildItems()) {
        if (!item.isRegularItem()) continue
        const issn = this.get(item, 'ISSN')
        const doi = this.get(item, 'DOI').replace(/^https?:\/\/doi.org\//i, '')
        const rank = (ranking.rows.find(row => row.doi === doi) || ranking.rows.find(row => row.issn === issn))?.asreview_ranking
        if (typeof rank !== 'undefined') this.ranking[collectionID].rank[item.itemID] = rank
      }
    }
  }

  async updateItem(item) {
    if (!item) return
    if (!item.isAttachment() || item.getField('title') !== ranking_attachment) return

    this.log(`updating item ${item.id}`)
    for (const collectionID of item.getCollections()) {
      await this.updateCollection(collectionID)
    }
  }

}

Zotero.ASReview = new ASReview

function notify(event: string, handler: any) {
  Zotero.Notifier.registerObserver({
    // eslint-disable-next-line prefer-arrow/prefer-arrow-functions
    async notify() {
      Zotero.debug(`asreview: ${event} event`)
      await ready.promise
      handler.apply(null, arguments) // eslint-disable-line prefer-spread, prefer-rest-params
    },
  }, [event], 'ASReview', 1)
}

notify('item', async (action: string, _type: string, ids: number[]) => {
  if (action !== 'modify') return

  for (const ranking of await Zotero.Items.getAsync(ids)) {
    await Zotero.ASReview.updateItem(ranking)
  }
})

notify('collection', async (event: string, _type: any, ids: number[]) => {
  for (const collectionID of ids) {
    await Zotero.ASReview.updateCollection(collectionID)
  }
})

notify('collection-item', async (_event: any, _type: string, collection_items: string[]) => {
  for (const collection_item of collection_items) {
    const collectionID = parseInt(collection_item.replace(/-.*/, ''))
    if (!isNaN(collectionID)) {
      await Zotero.ASReview.updateCollection(collectionID)
    }
  }
})
