import { describe, expect, it } from 'vitest';
import { Candidate, SendHandle, UploadItem, UploadQueue, planUploads, resolveConflicts } from './upload-queue';

/** Faux expéditeur : chaque envoi reste en suspens jusqu'à ce que le test le termine. */
function fakeSender() {
  const calls: { item: UploadItem<string>; resolve: (r: string) => void; reject: (e: unknown) => void;
                 progress: (l: number, t: number) => void; aborted: boolean }[] = [];
  const sender = (item: UploadItem<string>, onProgress: (l: number, t: number) => void): SendHandle<string> => {
    let resolve!: (r: string) => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    const call = { item, resolve, reject, progress: onProgress, aborted: false };
    calls.push(call);
    return { done, abort: () => { call.aborted = true; } };
  };
  return { sender, calls };
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));
const up = (path: string, size = 10) => ({ namespace: 'ns', path, size, payload: path });
const statuses = (q: UploadQueue<string, string>) => q.list().map(i => `${i.name}:${i.status}`);

describe('UploadQueue', () => {
  it('n\'envoie que `concurrency` fichiers à la fois, dans l\'ordre', async () => {
    const { sender, calls } = fakeSender();
    const q = new UploadQueue(sender, { concurrency: 2 });
    q.add([up('a'), up('b'), up('c'), up('d')]);
    expect(statuses(q)).toEqual(['a:uploading', 'b:uploading', 'c:queued', 'd:queued']);
    calls[0].resolve('ok');
    await tick();
    expect(statuses(q)).toEqual(['a:done', 'b:uploading', 'c:uploading', 'd:queued']);
    expect(calls.map(c => c.item.name)).toEqual(['a', 'b', 'c']);
  });

  it('progression par fichier, et onDone avec le résultat', async () => {
    const { sender, calls } = fakeSender();
    const done: string[] = [];
    const q = new UploadQueue(sender, { onDone: (item, r) => done.push(`${item.path}=${r}`) });
    q.add([up('a', 100)]);
    calls[0].progress(40, 100);
    expect(q.list()[0].loaded).toBe(40);
    // Le total annoncé par le navigateur inclut l'enveloppe multipart : la taille du fichier ne change pas.
    calls[0].progress(250, 500);
    expect(q.list()[0]).toMatchObject({ loaded: 50, size: 100 });
    calls[0].resolve('R');
    await tick();
    expect(q.list()[0]).toMatchObject({ status: 'done', loaded: 100 });
    expect(done).toEqual(['a=R']);
  });

  it('un échec n\'arrête pas la file', async () => {
    const { sender, calls } = fakeSender();
    const q = new UploadQueue(sender, { concurrency: 1, describeError: e => `Échec : ${e}` });
    q.add([up('a'), up('b'), up('c')]);
    calls[0].reject('503');
    await tick();
    expect(statuses(q)).toEqual(['a:error', 'b:uploading', 'c:queued']);
    expect(q.list()[0].error).toBe('Échec : 503');
    calls[1].resolve('ok');
    await tick();
    expect(statuses(q)).toEqual(['a:error', 'b:done', 'c:uploading']);
  });

  it('relance d\'un fichier en échec', async () => {
    const { sender, calls } = fakeSender();
    const q = new UploadQueue(sender, { concurrency: 1 });
    q.add([up('a')]);
    calls[0].reject('x');
    await tick();
    q.retry(q.list()[0].id);
    expect(statuses(q)).toEqual(['a:uploading']);
    expect(q.list()[0].error).toBeUndefined();
    calls[1].resolve('ok');
    await tick();
    expect(statuses(q)).toEqual(['a:done']);
  });

  it('annulation d\'un envoi en cours : interrompt et libère la place', async () => {
    const { sender, calls } = fakeSender();
    const q = new UploadQueue(sender, { concurrency: 1 });
    q.add([up('a'), up('b')]);
    q.cancel(q.list()[0].id);
    expect(calls[0].aborted).toBe(true);
    expect(statuses(q)).toEqual(['a:canceled', 'b:uploading']);
    // La fin tardive de l'envoi annulé ne doit rien changer.
    calls[0].resolve('trop tard');
    await tick();
    expect(statuses(q)).toEqual(['a:canceled', 'b:uploading']);
  });

  it('annulation d\'un fichier en attente : il ne part jamais', async () => {
    const { sender, calls } = fakeSender();
    const q = new UploadQueue(sender, { concurrency: 1 });
    q.add([up('a'), up('b'), up('c')]);
    q.cancel(q.list()[1].id);
    calls[0].resolve('ok');
    await tick();
    expect(statuses(q)).toEqual(['a:done', 'b:canceled', 'c:uploading']);
    expect(calls.map(c => c.item.name)).toEqual(['a', 'c']);
  });

  it('un fichier annulé peut être relancé', () => {
    const { sender } = fakeSender();
    const q = new UploadQueue(sender, { concurrency: 1 });
    q.add([up('a')]);
    q.cancel(q.list()[0].id);
    q.retry(q.list()[0].id);
    expect(statuses(q)).toEqual(['a:uploading']);
  });

  it('tout annuler', () => {
    const { sender, calls } = fakeSender();
    const q = new UploadQueue(sender, { concurrency: 2 });
    q.add([up('a'), up('b'), up('c')]);
    q.cancelAll();
    expect(statuses(q)).toEqual(['a:canceled', 'b:canceled', 'c:canceled']);
    expect(calls.filter(c => c.aborted)).toHaveLength(2);
  });

  it('refus avant envoi : en échec, jamais envoyé, non relançable', () => {
    const { sender, calls } = fakeSender();
    const q = new UploadQueue(sender);
    q.addRejected(up('gros.bin'), 'Trop volumineux');
    q.retry(q.list()[0].id);
    expect(q.list()[0]).toMatchObject({ status: 'error', error: 'Trop volumineux', retryable: false });
    expect(calls).toHaveLength(0);
  });

  it('clearFinished ne garde que ce qui est en cours ou en attente', async () => {
    const { sender, calls } = fakeSender();
    const q = new UploadQueue(sender, { concurrency: 1 });
    q.add([up('a'), up('b'), up('c')]);
    calls[0].resolve('ok');
    await tick();
    q.clearFinished();
    expect(statuses(q)).toEqual(['b:uploading', 'c:queued']);
  });

  it('activePaths : seulement en cours ou en attente, par espace', async () => {
    const { sender, calls } = fakeSender();
    const q = new UploadQueue(sender, { concurrency: 1 });
    q.add([up('a'), up('b'), { namespace: 'autre', path: 'z', size: 1, payload: 'z' }]);
    calls[0].resolve('ok');
    await tick();
    expect(q.activePaths('ns')).toEqual(['b']);
  });

  it('onChange reçoit une copie', () => {
    const { sender } = fakeSender();
    let last: UploadItem<string>[] = [];
    const q = new UploadQueue(sender, { onChange: items => { last = items; } });
    q.add([up('a')]);
    last[0].status = 'done';
    expect(q.list()[0].status).toBe('uploading');
  });
});

describe('conflits de nom', () => {
  const c = (path: string): Candidate<string> => ({ path, size: 1, payload: path });
  const paths = (list: Candidate<string>[]) => list.map(x => x.path);

  it('sépare les chemins libres des chemins occupés', () => {
    const plan = planUploads([c('a.txt'), c('b.txt')], new Set(['a.txt']));
    expect(paths(plan.free)).toEqual(['b.txt']);
    expect(paths(plan.conflicts)).toEqual(['a.txt']);
  });

  it('deux candidats pour le même chemin : le second est un conflit', () => {
    const plan = planUploads([c('a.txt'), c('a.txt')], new Set());
    expect(paths(plan.free)).toEqual(['a.txt']);
    expect(paths(plan.conflicts)).toEqual(['a.txt']);
  });

  it('un fichier ne prend pas le nom d\'un dossier existant', () => {
    expect(paths(planUploads([c('photos')], new Set(['photos'])).conflicts)).toEqual(['photos']);
  });

  it('ignorer : seuls les libres partent', () => {
    const taken = new Set(['a.txt']);
    expect(paths(resolveConflicts(planUploads([c('a.txt'), c('b.txt')], taken), 'skip', taken))).toEqual(['b.txt']);
  });

  it('remplacer : tout part au chemin d\'origine', () => {
    const taken = new Set(['a.txt']);
    expect(paths(resolveConflicts(planUploads([c('a.txt'), c('b.txt')], taken), 'replace', taken)).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('garder les deux : nouveau nom libre, l\'original n\'est pas visé', () => {
    const taken = new Set(['a.txt', 'a (2).txt', 'd/x.png']);
    const out = paths(resolveConflicts(planUploads([c('a.txt'), c('d/x.png'), c('b.txt')], taken), 'keep-both', taken));
    expect(out).toEqual(['b.txt', 'a (3).txt', 'd/x (2).png']);
  });

  it('garder les deux : deux conflits sur le même nom reçoivent des noms différents', () => {
    const taken = new Set(['a.txt']);
    const out = paths(resolveConflicts(planUploads([c('a.txt'), c('a.txt')], new Set(['a.txt'])), 'keep-both', taken));
    expect(out).toEqual(['a (2).txt', 'a (3).txt']);
  });

  it('garder les deux : un nom pris dans un AUTRE dossier ne compte pas', () => {
    const taken = new Set(['d/a.txt', 'a (2).txt']);
    const out = paths(resolveConflicts(planUploads([c('d/a.txt')], taken), 'keep-both', taken));
    expect(out).toEqual(['d/a (2).txt']);
  });
});
