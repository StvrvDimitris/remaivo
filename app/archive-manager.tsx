"use client";

import { useTranslation } from "./i18n";

import { useEffect, useState } from "react";
import { DialogFrame, DialogHeading, DialogSubmit, FormField } from "./dialog-ui";
import { archiveKinds, type ArchiveKind, type ArchiveItem, type ArchivePage } from "./archive-types";

export function ArchiveManager({ currency, today, busy, saveError, clearError, close, save }: {
  currency: string; today: string; busy: boolean; saveError: string; clearError: () => void; close: () => void;
  save: (action: string, payload: Record<string, unknown>) => Promise<boolean>;
}) {
 const { t: tr, locale } = useTranslation();

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ArchiveKind | "all">("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ArchivePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<ArchiveItem | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setError("");
      try {
        const params = new URLSearchParams({ view: "archive", q: query, kind, page: String(page) });
        const response = await fetch(`/api/finance?${params}`, { signal: controller.signal, cache: "no-store" });
        const result = await response.json() as ArchivePage;
        if (!response.ok) throw new Error(result.error || "Unable to load the archive.");
        setData(result);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : tr("Unable to load the archive."));
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, kind, page, revision, tr]);
  const money = (item: ArchiveItem) => item.amount_cents === null ? null : new Intl.NumberFormat(locale, { style: "currency", currency: item.currency || currency }).format(item.amount_cents / 100);
  const scheduled = selected && ["recurring", "installment"].includes(selected.kind);
  async function restore(nextDate?: string) {
    if (!selected) return;
    if (await save("restoreArchived", { kind: selected.kind, id: selected.id, nextDate })) {
      setNotice(`${selected.name} restored`); setSelected(null); setLoading(true); setRevision(value => value + 1);
    }
  }
  return <div className="modal-backdrop archive-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <DialogFrame className="modal-card archive-manager" currency={currency} close={close}>
      <DialogHeading title={selected ? tr("Restore item") : tr("Archive manager")} icon="archive" copy={selected ? selected.name : tr("Find and restore items removed from active views. History stays intact.")}/>
      {selected ? <>
        <button type="button" className="text-link archive-back" disabled={busy} onClick={() => { clearError(); setSelected(null); }}>{tr("Back to archive")}</button>
        <div className="archive-restore-summary"><span className="archive-type">{tr(archiveKinds[selected.kind])}</span><h3>{selected.name}</h3><p>{selected.detail}{money(selected) && ` · ${money(selected)}`}</p></div>
        {saveError && <p className="form-error" role="alert">{tr(saveError)}</p>}
        <form onSubmit={event => { event.preventDefault(); void restore(String(new FormData(event.currentTarget).get("nextDate") || "")); }}>
          {scheduled ? <><FormField label={selected.kind === "installment" ? tr("Next unpaid payment") : tr("Restart from")}><input name="nextDate" type="date" min={today} defaultValue={today} required/></FormField><p className="archive-restore-note">{selected.kind === "installment" ? tr("Unpaid payments resume from this date at the original frequency. Paid payments stay untouched.") : tr("Payments resume from this date. Older missed payments will not be caught up.")}  {tr("Automatic posting stays off; review the restored plan before enabling it.")}</p></> : <p className="archive-restore-note">{selected.kind === "bucket" ? tr("Restores this period’s protection and repeats the bucket in future periods. Any changes already made to this period’s allocation are kept.") : selected.kind === "account" ? tr("Returns this account to active views and transaction choices, keeping its existing balance and history.") : selected.kind === "goal" ? tr("Returns this goal with its original tracking settings and progress history.") : tr("Makes this category available for new entries. Existing transaction links stay intact.")}</p>}
          <DialogSubmit busy={busy} label={tr("Restore item")}/>
        </form>
      </> : <>
        <div className="archive-filters"><FormField label={tr("Search archived items")}><input type="search" value={query} placeholder={tr("Search by name or details")} onChange={event => { setQuery(event.target.value); setPage(1); setNotice(""); }}/></FormField><FormField label={tr("Item type")}><select value={kind} onChange={event => { setKind(event.target.value as ArchiveKind | "all"); setPage(1); setNotice(""); }}><option value="all">{tr("All types")}</option>{Object.entries(archiveKinds).map(([value, label]) => <option key={value} value={value}>{tr(label)}</option>)}</select></FormField></div>
        {notice && <p className="archive-notice" role="status">{notice}</p>}
        {error ? <div className="archive-load-error" role="alert"><p>{tr(error)}</p><button type="button" className="ghost-button" onClick={() => setRevision(value => value + 1)}>{tr("Try again")}</button></div> : loading ? <p className="archive-empty" role="status">{tr("Loading archived items…")}</p> : data && <>
          <p className="archive-count">{data.total} {data.total === 1 ? "archived item" : "archived items"}</p>
          <div className="archive-list">{data.items.map(item => <article key={`${item.kind}:${item.id}`}><div><span className="archive-type">{tr(archiveKinds[item.kind])}</span><h3>{item.name}</h3><p>{item.detail}{money(item) && ` · ${money(item)}`}</p></div><button type="button" className="ghost-button" onClick={() => { clearError(); setSelected(item); setNotice(""); }} aria-label={`Restore ${item.name}`}>{tr("Restore")}</button></article>)}</div>
          {!data.items.length && <p className="archive-empty">{query || kind !== "all" ? tr("No archived items match these filters.") : "Nothing archived. Items you archive will appear here."}</p>}
          {data.totalPages > 1 && <nav className="archive-pagination" aria-label={tr("Archive pages")}><button type="button" className="ghost-button" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>{tr("Previous")}</button><span>{tr("Page")} {data.page}  {tr("of")} {data.totalPages}</span><button type="button" className="ghost-button" disabled={data.page >= data.totalPages} onClick={() => setPage(data.page + 1)}>{tr("Next")}</button></nav>}
        </>}
      </>}
    </DialogFrame>
  </div>;
}
