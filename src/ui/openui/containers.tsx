// Tabs and Accordion that open on their first item. OpenUI's own versions follow whichever item
// streamed in last, which on a complete Canvas view always means the last tab or section.
import React, { useState } from 'react';
import { defineComponent, type ComponentRenderer } from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui/genui-lib';
import { Tabs as UITabs, TabsContent, TabsList, TabsTrigger } from '@openuidev/react-ui/Tabs';
import { Accordion as UIAccordion, AccordionContent, AccordionItem, AccordionTrigger } from '@openuidev/react-ui/Accordion';

type Item = { props: { value: string; trigger: string; content: unknown[] } };
const itemsOf = (value: unknown) => (Array.isArray(value) ? value : []).filter((i): i is Item => typeof i?.props?.value === 'string');

const TabsView: ComponentRenderer<{ items: unknown }> = ({ props, renderNode }) => {
  const items = itemsOf(props.items);
  const [active, setActive] = useState<string>();
  if (!items.length) return null;
  const value = items.some(i => i.props.value === active) ? active : items[0].props.value;
  return <UITabs value={value} onValueChange={setActive}>
    <TabsList>{items.map(i => <TabsTrigger key={i.props.value} value={i.props.value} text={i.props.trigger}/>)}</TabsList>
    {items.map(i => <TabsContent key={i.props.value} value={i.props.value}>{renderNode(i.props.content)}</TabsContent>)}
  </UITabs>;
};

const AccordionView: ComponentRenderer<{ items: unknown }> = ({ props, renderNode }) => {
  const items = itemsOf(props.items);
  const [open, setOpen] = useState<string>();
  if (!items.length) return null;
  return <UIAccordion type="single" collapsible value={open ?? items[0].props.value} onValueChange={setOpen}>
    {items.map(i => <AccordionItem key={i.props.value} value={i.props.value}>
      <AccordionTrigger text={i.props.trigger}/>
      <AccordionContent>{renderNode(i.props.content)}</AccordionContent>
    </AccordionItem>)}
  </UIAccordion>;
};

// Same schema and description as OpenUI's, so prompts, parsing and parent slots are unchanged.
const base = openuiLibrary.components;
export const Tabs = defineComponent({ name: 'Tabs', props: base.Tabs.props, description: base.Tabs.description, component: TabsView });
export const Accordion = defineComponent({ name: 'Accordion', props: base.Accordion.props, description: base.Accordion.description, component: AccordionView });
