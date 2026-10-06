// XML reading for tool reports (JaCoCo, Checkstyle). The document is validated and parsed with
// fast-xml-parser, then narrowed from unknown into plain elements. Entity expansion is
// bounded, so a declared entity bomb is left unexpanded instead of exhausting memory.
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { isRecord } from "@quality/io.ts";

export type XmlElement = { name: string; attributes: Record<string, string>; children: XmlElement[] };

// The document is not well-formed XML (ElementTree's ParseError).
export class XmlParseError extends Error {}

const ATTRIBUTES_KEY = ":@";
const ENTITY_LIMITS = { enabled: true, maxEntitySize: 1000, maxTotalExpansions: 100, maxExpandedLength: 10_000, maxEntityCount: 10 };
const NON_ELEMENT_KEY = /^(#|\?|!)/;
const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: ENTITY_LIMITS,
});

function attributesOf(node: Record<string, unknown>): Record<string, string> {
  const raw = node[ATTRIBUTES_KEY];
  if (!isRecord(raw)) return {};
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) attributes[key] = typeof value === "string" ? value : String(value);
  return attributes;
}

function elementsOf(nodes: unknown): XmlElement[] {
  if (!Array.isArray(nodes)) return [];
  const elements: XmlElement[] = [];
  for (const node of nodes as unknown[]) {
    if (!isRecord(node)) continue;
    const name = Object.keys(node).find((key) => key !== ATTRIBUTES_KEY && !NON_ELEMENT_KEY.test(key));
    if (name === undefined) continue;
    elements.push({ name, attributes: attributesOf(node), children: elementsOf(node[name]) });
  }
  return elements;
}

export function parseXml(text: string): XmlElement {
  const verdict = XMLValidator.validate(text);
  if (verdict !== true) throw new XmlParseError(verdict.err.msg);
  let parsed: unknown;
  try {
    parsed = parser.parse(text);
  } catch (error) {
    throw new XmlParseError(error instanceof Error ? error.message : String(error));
  }
  const roots = elementsOf(parsed);
  const [root] = roots;
  if (root === undefined || roots.length !== 1) throw new XmlParseError("document must have exactly one root element");
  return root;
}

// Element.iter(name): the element itself and every descendant with that name, in document order.
export function findElements(element: XmlElement, name: string): XmlElement[] {
  const found = element.name === name ? [element] : [];
  for (const child of element.children) found.push(...findElements(child, name));
  return found;
}

// int(element.get(name, default)): a missing attribute takes the default, a non-integer fails.
export function integerAttribute(element: XmlElement, name: string, fallback: number): number {
  const raw = element.attributes[name];
  if (raw === undefined) return fallback;
  if (!INTEGER_TEXT.test(raw)) throw new TypeError(`<${element.name}> ${name}="${raw}" is not an integer`);
  return Number(raw);
}
