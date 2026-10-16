// Form fields and charts whose upstream behavior breaks a Canvas view. Each keeps OpenUI's schema and description,
// so prompts, parsing and parent slots are unchanged; only rendering or the stored value differs.
import React, { useEffect, useMemo, useState } from 'react';
import { defineComponent, isReactiveAssign, parseStructuredRules, useFormName, useFormValidation, useGetFieldValue, useSetDefaultValue, useStateField, type ComponentRenderer } from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui/genui-lib';
import { DatePicker as UIDatePicker } from '@openuidev/react-ui/DatePicker';

type Props = { name: string; value?: unknown; defaultValue?: unknown; label?: string; items?: Array<{ props: { name: string; defaultChecked?: boolean } }> };
const base = openuiLibrary.components;
const checked = (p: Props) => p.items?.length ? Object.fromEntries(p.items.map(i => [i.props.name, i.props.defaultChecked ?? false])) : undefined;

// Upstream Chips and OptionCards store their default in form state, but these four only draw it, so an untouched
// default never reached the agent and required-field validation saw it as empty.
function withDefault(name: 'RadioGroup' | 'Slider' | 'CheckBoxGroup' | 'SwitchGroup', initial: (p: Props) => unknown) {
  const Upstream = base[name].component as ComponentRenderer<Props>;
  const Field: ComponentRenderer<Props> = rp => {
    const formName = useFormName(), get = useGetFieldValue();
    // A $variable binding holds its own value; only plain fields need seeding.
    const existingValue = isReactiveAssign(rp.props.value) ? rp.props.value : get(formName, rp.props.name);
    useSetDefaultValue({ formName, componentType: name, name: rp.props.name, existingValue, defaultValue: initial(rp.props) });
    // A Slider without a label shows its field name (a key like "ttlMinutes") under the FormControl's real label.
    if (name === 'Slider' && !rp.props.label) return <div className="canvas-slider-unlabeled"><Upstream {...rp}/></div>;
    return <Upstream {...rp}/>;
  };
  return defineComponent({ name, props: base[name].props, description: base[name].description, component: Field as never });
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A calendar day as YYYY-MM-DD from local date parts, so no time zone moves it to the day before or after. */
const calendarDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(+value) ? undefined : value;
  if (typeof value !== 'string') return undefined;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
  return Number.isNaN(+date) ? undefined : date;
}
type DateProps = { name: string; mode?: 'single' | 'range'; rules?: unknown; value?: unknown };
/**
 * Upstream stores a Date, which required-field validation reads as empty (it has no own keys) and which reaches the
 * agent as a UTC timestamp of local midnight, a day early east of UTC. This stores "YYYY-MM-DD" (a { from, to } pair
 * of them for a range), and closes the calendar once a date is picked or on Escape so it never covers the form.
 */
const DatePickerField: ComponentRenderer<DateProps> = ({ props }) => {
  const validation = useFormValidation(), field = useStateField(props.name, props.value as never);
  const rules = useMemo(() => parseStructuredRules(props.rules as never), [props.rules]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!rules.length || !validation) return;
    validation.registerField(field.name, rules, () => field.value);
    return () => validation.unregisterField(field.name);
  }, [field.name, field.value, validation, rules]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [open]);
  const store = (value: unknown) => {
    field.setValue(value as never);
    if (rules.length) validation?.validateField(field.name, value, rules);
  };
  if (props.mode === 'range') {
    const stored = field.value as { from?: unknown; to?: unknown } | undefined;
    const range = stored && typeof stored === 'object' ? { from: toDate(stored.from), to: toDate(stored.to) } : undefined;
    return <UIDatePicker mode="range" isOpen={open} setIsOpen={setOpen} selectedRangeDates={range} setSelectedRangeDates={r => {
      store(r?.from ? { from: calendarDay(r.from), ...(r.to ? { to: calendarDay(r.to) } : {}) } : undefined);
      if (r?.from && r.to && +r.from !== +r.to) setOpen(false);
    }}/>;
  }
  return <UIDatePicker mode="single" isOpen={open} setIsOpen={setOpen} selectedSingleDate={toDate(field.value)} setSelectedSingleDate={d => {
    store(d ? calendarDay(d) : undefined);
    setOpen(false);
  }}/>;
};

type ScatterProps = { datasets?: unknown; xLabel?: string; yLabel?: string };
const UpstreamScatter = base.ScatterChart.component as ComponentRenderer<ScatterProps>;
/** Upstream drops ScatterChart's axis labels; show them under the chart instead of losing them. */
const ScatterWithAxes: ComponentRenderer<ScatterProps> = rp => {
  const axes = [rp.props.xLabel && `Horizontal: ${rp.props.xLabel}`, rp.props.yLabel && `Vertical: ${rp.props.yLabel}`].filter(Boolean);
  if (!axes.length) return <UpstreamScatter {...rp}/>;
  return <div className="canvas-chart-with-axes"><UpstreamScatter {...rp}/><p className="canvas-chart-axes">{axes.join(' · ')}</p></div>;
};

export const fieldsWithDefaults = [
  withDefault('RadioGroup', p => p.defaultValue),
  withDefault('Slider', p => p.defaultValue),
  withDefault('CheckBoxGroup', checked),
  withDefault('SwitchGroup', checked),
  defineComponent({ name: 'DatePicker', props: base.DatePicker.props, description: base.DatePicker.description, component: DatePickerField as never }),
  defineComponent({ name: 'ScatterChart', props: base.ScatterChart.props, description: base.ScatterChart.description, component: ScatterWithAxes as never }),
];
