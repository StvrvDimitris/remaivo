"use client";

import { Children, cloneElement, createContext, isValidElement, useContext, useId, useState, type ReactElement, type ReactNode } from "react";

const Currency = createContext<string | null>(null);
const HeadingId = createContext<string | undefined>(undefined);
type ActionProps = { busy: boolean; label: string };

export function DialogSubmit({ busy, label }: ActionProps) {
  return <button className="primary-button modal-submit" type="submit" disabled={busy}>{busy ? "Saving…" : label}</button>;
}

// Keep the original form and submit handler intact, while placing its action
// outside the scrolling body. Native form association retains validation and Enter.
export function DialogFrame({ children, close, currency, className = "", labelledBy }: { children: ReactNode; close: () => void; currency: string; className?: string; labelledBy?: string }) {
  const id = useId();
  let action: (ActionProps & { form: string }) | null = null;
  let formIndex = 0;
  function layout(nodes: ReactNode, form?: string): ReactNode {
    return Children.map(nodes, node => {
      if (!isValidElement(node)) return node;
      const element = node as ReactElement<{ children?: ReactNode; id?: string }>;
      if (element.type === DialogSubmit && form) {
        action = { ...(element.props as ActionProps), form };
        return null;
      }
      const formId = element.type === "form" ? `${id}-form-${formIndex++}` : form;
      if (!element.props.children) return element;
      return cloneElement(element, element.type === "form" ? { id: formId } : {}, layout(element.props.children, formId));
    });
  }
  const body = layout(children);
  const primary = action as (ActionProps & { form: string }) | null;
  return <Currency.Provider value={currency}><HeadingId.Provider value={labelledBy || `${id}-title`}><section className={`dialog-frame ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy || `${id}-title`}>
    <button type="button" className="modal-close" onClick={close} aria-label="Close">×</button>
    <div className="dialog-scroll">{body}</div>
    <footer className="dialog-footer"><span className="dialog-key-hint"><kbd>Esc</kbd> to close</span><button type="button" className="ghost-button" onClick={close}>{primary ? "Cancel" : "Close"}</button>{primary && <button type="submit" form={primary.form} className="primary-button" disabled={primary.busy}>{primary.busy ? "Saving…" : primary.label}</button>}</footer>
  </section></HeadingId.Provider></Currency.Provider>;
}

export function DialogHeading({ title, copy, icon = "entry", id }: { title: string; copy?: string; icon?: string; id?: string }) {
  const headingId = useContext(HeadingId);
  const paths: Record<string, string> = { entry: "M12 4v16M4 12h16", account: "M3 7h18v13H3V7Zm0 0 14-4v4M16 12h5v4h-5", goal: "M12 3l8 9-8 9-8-9 8-9Z", category: "M3 3h8l10 10-8 8L3 11V3Zm4 4h.01", plan: "M5 4h14v17H5V4Zm3-2v4m8-4v4M8 10h8M8 14h8", spare: "M4 8a8 8 0 0 1 14-2l2 2M20 3v5h-5M20 16a8 8 0 0 1-14 2l-2-2M4 21v-5h5" };
  return <header className="dialog-heading"><span className="dialog-heading-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[icon] || paths.plan}/></svg></span><div><h2 id={id || headingId}>{title}</h2>{copy && <p>{copy}</p>}</div></header>;
}

export function FormField({ label, children }: { label: string; children: ReactNode }) {
  const currency = useContext(Currency);
  const elements = Children.toArray(children);
  const input = elements.length === 1 && isValidElement(elements[0]) ? elements[0] as ReactElement<{ type?: string; step?: string }> : null;
  const money = currency && input?.type === "input" && input.props.type === "number" && input.props.step === "0.01";
  const symbol = currency ? new Intl.NumberFormat("en", { style: "currency", currency }).formatToParts(0).find(part => part.type === "currency")?.value : "";
  if (input?.type === ColorPicker) return <div className="form-field"><span>{label}</span>{children}</div>;
  return <label className={`form-field${money ? " money-field" : ""}`}><span>{label}</span>{money ? <span className="money-input"><i aria-hidden="true">{symbol}</i>{children}</span> : children}</label>;
}

export function ColorPicker({ name = "color", defaultValue }: { name?: string; defaultValue: string }) {
  const [value, setValue] = useState(defaultValue);
  const palette = ["#12a16b", "#365bd6", "#228e9d", "#8563c7", "#d68b64", "#df5e6a", "#1f5b4e", "#cfe9d7"];
  return <span className="color-picker"><input name={name} type="hidden" value={value}/>{palette.map(color => <button type="button" key={color} style={{ background: color }} aria-label={`Use colour ${color}`} aria-pressed={value === color} onClick={() => setValue(color)}>{value === color ? "✓" : ""}</button>)}<input type="color" value={value} aria-label="Custom colour" onChange={event => setValue(event.target.value)}/></span>;
}

export function ChoiceField({ label, name, defaultValue, options }: { label: string; name: string; defaultValue: string | number; options: { value: string | number; label: string }[] }) {
  const [value, setValue] = useState(String(defaultValue));
  return <div className="form-field"><span>{label}</span><input type="hidden" name={name} value={value}/><div className="segmented choice-field" role="group" aria-label={label}>{options.map(option => <button type="button" key={option.value} className={value === String(option.value) ? "active" : ""} aria-pressed={value === String(option.value)} onClick={() => setValue(String(option.value))}>{option.label}</button>)}</div></div>;
}
