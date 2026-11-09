import { parseInline } from "../lib/inlineMarkup.js";
import { followInternalLink, isModifiedClick } from "../router.js";

/**
 * Rich text for every content type. Text is stored as blocks with stable IDs
 * so a future inline editor can target, edit and save one block at a time.
 *
 *   { type: "paragraph", text }
 *   { type: "heading", level: 2 | 3 | 4, text }
 *   { type: "list", ordered?: boolean, items: (string | { text, list })[] }   (lists nest)
 *   { type: "quote", text }
 *   { type: "code", language?: string, text }        (shown as-is, never formatted)
 *   { type: "divider" }                              (a horizontal rule)
 *   { type: "details", summary, blocks: [...] }      (expandable section)
 *
 * Inline formatting inside text: **bold**, *italic*, `code`, [label](url).
 * Unknown block types are skipped so older clients never crash on newer content.
 */

function InlineNodes({ nodes }) {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.value;
      case "code":
        return <code key={index}>{node.value}</code>;
      case "strong":
        return (
          <strong key={index}>
            <InlineNodes nodes={node.children} />
          </strong>
        );
      case "em":
        return (
          <em key={index}>
            <InlineNodes nodes={node.children} />
          </em>
        );
      case "link":
        return <InlineLink href={node.href} key={index} nodes={node.children} />;
      default:
        return null;
    }
  });
}

function InlineLink({ href, nodes }) {
  if (href.startsWith("#")) {
    return (
      <a href={href} onClick={(event) => !isModifiedClick(event) && followInternalLink(event, href)}>
        <InlineNodes nodes={nodes} />
      </a>
    );
  }
  const isWeb = /^https?:/i.test(href);
  return (
    <a href={href} rel={isWeb ? "noreferrer" : undefined} target={isWeb ? "_blank" : undefined}>
      <InlineNodes nodes={nodes} />
      {isWeb && <span className="visually-hidden"> (opens in a new tab)</span>}
    </a>
  );
}

export function Inline({ text }) {
  return <InlineNodes nodes={parseInline(text)} />;
}

/** A list; an item is text, or text with a nested list ({ text, list }). */
function ListBlock({ items, ordered }) {
  const List = ordered ? "ol" : "ul";
  return (
    <List>
      {(items ?? []).map((item, index) =>
        typeof item === "string" ? (
          <li key={index}>
            <Inline text={item} />
          </li>
        ) : (
          <li key={index}>
            <Inline text={item?.text} />
            {item?.list && <ListBlock items={item.list.items} ordered={item.list.ordered} />}
          </li>
        ),
      )}
    </List>
  );
}

function Block({ block }) {
  switch (block.type) {
    case "paragraph":
      return (
        <p>
          <Inline text={block.text} />
        </p>
      );

    // The panel title is an h2, so content headings start at h3.
    case "heading": {
      const Heading = block.level === 4 ? "h5" : block.level === 3 ? "h4" : "h3";
      return (
        <Heading>
          <Inline text={block.text} />
        </Heading>
      );
    }

    case "list":
      return <ListBlock items={block.items} ordered={block.ordered} />;

    case "divider":
      return <hr />;

    case "quote":
      return (
        <blockquote>
          <p>
            <Inline text={block.text} />
          </p>
        </blockquote>
      );

    case "code":
      return (
        // Always left-to-right, even inside Arabic text. Focusable so keyboard
        // users can scroll long lines horizontally.
        <pre aria-label={block.language ? `${block.language} example` : "Code example"} dir="ltr" tabIndex={0}>
          <code>{block.text}</code>
        </pre>
      );

    case "details":
      return (
        <details className="rich-details">
          <summary>
            <Inline text={block.summary} />
          </summary>
          <div className="rich-details__body">
            <RichBlocks blocks={block.blocks ?? []} />
          </div>
        </details>
      );

    default:
      return null;
  }
}

export function RichBlocks({ blocks }) {
  return blocks.map((block) => <Block block={block} key={block.id} />);
}

export default function RichText({ blocks }) {
  return (
    <div className="rich-text">
      <RichBlocks blocks={blocks} />
    </div>
  );
}
