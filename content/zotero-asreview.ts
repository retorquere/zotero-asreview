declare const Zotero: any
declare const OS: any
declare const ZoteroPane_Local: any
// declare const Components: any
import * as csv from 'papaparse'
import type BluebirdPromise from 'bluebird'
import * as l10n from './l10n'

const monkey_patch_marker = 'ASReviewMonkeyPatched'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function patch(object, method, patcher) {
  if (object[method][monkey_patch_marker]) return
  object[method] = patcher(object[method])
  object[method][monkey_patch_marker] = true
}

export class Deferred<ReturnType> {
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

function celltext(item): string {
  const collection = ZoteroPane_Local.getSelectedCollection()
  if (!collection) return ''
  const rankings = Zotero.ASReview.ranking[collection.id]
  if (!rankings || !item.isRegularItem()) return ''
  const ranking = rankings[item.id]
  return typeof ranking === 'undefined' ? '' : `${ranking}`
}

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

    if (Zotero.ASReview.ready.isPending()) {
      if (!itemTreeViewWaiting[item.id]) {
        itemTreeViewWaiting[item.id] = true
        Zotero.ASReview.ready.then(() => {
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

class ASReview { // tslint:disable-line:variable-name
  public ranking: Record<number, Ranking> = {} // collectionID -> ranking
  public ready: BluebirdPromise<boolean>

  private initialized = false
  private globals: Record<string, any>


  private decoder = new TextDecoder

  get(item: any, field: string): string {
    const prefix = `${field}:`
    return (item.getField(field) as string) || (item.getField('extra') as string)?.split('\n').find((line: string) => line.startsWith(prefix))?.replace(prefix, '') || ''
  }

  async add(collectionID, rankingID): Promise<void> {
    try {
      const collection = await Zotero.Collections.getAsync(collectionID)

      let ranking = await Zotero.Items.get(rankingID)
      if (!ranking) return (Zotero.debug(`attachment ${ranking.itemID} does not exist`) as void)
      const path = ranking.getAttachmentPath()
      ranking = (await OS.File.exists(path)) ? (await OS.File.open(path)) : null
      if (!ranking) return (Zotero.debug(`attachment ${path} does not exist`) as void)

      ranking = await OS.File.open(path)
      const stat = await ranking.stat()
      const updated = stat.lastModificationDate.getTime()

      if (this.ranking[collectionID]?.updated === updated) return

      this.ranking[collectionID] = {
        updated,
        rank: {},
      }

      const content = this.decoder.decode(await OS.File.read(path) as BufferSource)
      const delimiter = csv.parse(content.split('\n')[0]).meta.delimiter // papaparse autodetection is wonky
      const data = csv.parse(content, {
        delimiter,
        header: true,
        dynamicTyping: true,
      })

      for (const item of collection.getChildItems()) {
        if (!item.isRegularItem()) continue
        const issn = this.get(item, 'ISSN')
        const doi = this.get(item, 'DOI').replace(/^https?:\/\/doi.org\//i, '')
        ranking = data.data.find(rank => rank.doi === doi || rank.issn === issn)?.asreview_ranking
        if (typeof ranking !== 'undefined') this.ranking[collectionID].rank[item.itemID] = ranking
      }
    }
    catch (err) {
      Zotero.debug(err.message)
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async load(globals: Record<string, any>): Promise<void> {
    this.globals = globals
    if (this.initialized) return
    this.initialized = true

    const ready = new Deferred<boolean>()
    this.ready = ready.promise

    const ranking_attachment = 'asreview.csv'
    const rankings = `
      SELECT ci.collectionID, MAX(i.itemID) as itemID
      FROM items i
      JOIN itemAttachments ia ON i.itemID = ia.itemID AND ia.parentItemID IS NULL 
      JOIN itemData id ON i.itemID = i.itemID 
      JOIN itemDataValues idv ON idv.valueID = id.valueID AND idv.value = '${ranking_attachment}'
      JOIN fields f on f.fieldID = id.fieldID AND f.fieldName = 'title'
      JOIN collectionItems ci ON i.itemID = ci.itemID
      GROUP BY ci.collectionID
      `.replace(/\n/g, ' ')
    for (const ranking of await Zotero.DB.queryAsync(rankings)) {
      await this.add(ranking.collectionID, ranking.itemID)
    }

    ready.resolve(true)
  }
}

Zotero.ASReview = new ASReview
