// One request and one decoded asset per faction, shared by map stamps and viewers.
export function createAssetLibrary({ load, makeStamp, disposeAsset = () => {}, onReady = () => {}, onError = () => {} }) {
  const entries = new Map();
  let disposed = false;
  function ensure(id) {
    if (disposed) return Promise.reject(new Error('Asset library is closed'));
    if (entries.has(id)) { const entry=entries.get(id);entries.delete(id);entries.set(id,entry);return entry.promise; }
    const entry = { asset: null, stamp: null, error: null };
    entries.set(id, entry);
    entry.promise = Promise.resolve().then(() => {
      if (disposed) throw new Error('Asset library is closed');
      return load(id);
    }).then(asset => {
      if (disposed) { disposeAsset(asset); throw new Error('Asset library is closed'); }
      entry.asset = asset;
      entry.stamp = makeStamp(asset, id);
      onReady(id);
      return asset;
    }).catch(error => {
      if (entry.asset) { disposeAsset(entry.asset); entry.asset = null; }
      entry.error = error;
      if (!disposed) onError(id, error);
      throw error;
    });
    return entry.promise;
  }
  return {
    ensure,
    peekStamp(id) { return entries.get(id)?.stamp || null; },
    prune({keepIds=new Set(),maxEntries=6}={}) {
      for(const [id,entry]of entries){
        if(entries.size<=maxEntries)break;
        if(keepIds.has(id)||!entry.asset&&!entry.error)continue;
        if(entry.asset)disposeAsset(entry.asset);entries.delete(id);
      }
    },
    retry(id) {
      if (entries.get(id)?.error) entries.delete(id);
      return ensure(id);
    },
    getStamp(id) {
      if (disposed) return null;
      if (!entries.has(id)) ensure(id).catch(() => {});
      return entries.get(id)?.stamp || null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of entries.values()) if (entry.asset) disposeAsset(entry.asset);
      entries.clear();
    },
  };
}
