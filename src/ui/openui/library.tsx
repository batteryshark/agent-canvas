// The OpenUI library agents write against: OpenUI's standard library plus Canvas components.
// Node-safe (no CSS imports): the generator and tests load it outside the browser.
import React from 'react';
import { z } from 'zod';
import { defineComponent } from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui/genui-lib';
import { DiagramView, readDiagram } from './Diagram';
import { Accordion, Tabs } from './containers';
import { fieldsWithDefaults } from './defaults';

export const DiagramNode = defineComponent({
  name: 'DiagramNode',
  description: 'One node of a Diagram. id is unique within the diagram and is what edges reference; label is shown on the node (keep it short); group colors related nodes and adds a legend entry; detail is the text shown when the user clicks the node.',
  props: z.object({ id: z.string(), label: z.string(), group: z.string().optional(), detail: z.string().optional() }),
  component: () => null,
});

export const DiagramEdge = defineComponent({
  name: 'DiagramEdge',
  description: 'A directed connection in a Diagram from one DiagramNode id to another, with an optional short label (e.g. "reads", "on failure").',
  props: z.object({ from: z.string(), to: z.string(), label: z.string().optional() }),
  component: () => null,
});

export const Diagram = defineComponent({
  name: 'Diagram',
  description: 'Interactive directed graph laid out in layers: architectures, data flows, pipelines, dependencies, state machines, decision trees, org charts. Clicking a node shows its detail and its connections; wide graphs scroll horizontally. direction "right" (default) lays layers left to right, "down" top to bottom. Cycles are allowed.',
  props: z.object({
    nodes: z.array(DiagramNode.ref),
    edges: z.array(DiagramEdge.ref).optional(),
    direction: z.enum(['right', 'down']).optional(),
  }),
  component: ({ props }) => <DiagramView {...readDiagram(props)}/>,
});

/** Canvas components join the containers agents use most; Stack children already accept any component. */
const DIAGRAM_SLOTS = ['Card.children', 'TabItem.content', 'AccordionItem.content', 'Modal.children'];

export const canvasLibrary = openuiLibrary.extend!({
  components: { add: [DiagramNode, DiagramEdge, { component: Diagram, slots: DIAGRAM_SLOTS }], override: [Tabs, Accordion, ...fieldsWithDefaults] },
});
