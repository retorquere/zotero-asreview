declare const Zotero: any
declare const Components: any
const stringBundle = Components.classes['@mozilla.org/intl/stringbundle;1'].getService(Components.interfaces.nsIStringBundleService).createBundle('chrome://zotero-better-bibtex/locale/zotero-better-bibtex.properties')

export function localize(id: string): string {
  try {
    return stringBundle.GetStringFromName(id) as string
  }
  catch (err) {
    Zotero.debug(`l10n.get ${id}: ${err.message}`)
    return id
  }
}
