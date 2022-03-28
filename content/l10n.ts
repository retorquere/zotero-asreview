declare const Zotero: any
declare const Components: any

const stringBundleService = Components.classes['@mozilla.org/intl/stringbundle;1'].getService(Components.interfaces.nsIStringBundleService)
const stringBundle = stringBundleService.createBundle('chrome://zotero-asreview/locale/zotero-asreview.properties')
export function localize(id: string): string {
  try {
    return stringBundle.GetStringFromName(id) as string
  }
  catch (err) {
    Zotero.debug(`l10n.get ${id}: ${err.message}`)
    return id
  }
}
