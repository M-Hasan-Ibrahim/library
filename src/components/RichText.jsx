import { parseInline } from "../lib/inlineMarkup.js";
import { followInternalLink, isModifiedClick } from "../router.js";

/**
 * Rich text for every content type. Text is stored as blocks with stable IDs
 * so a future inline editor can target, edit and save one block at a time.
 *
 *   { type: "paragraph", text }
 *   { type: "heading", level: 2 | 3, text }
 *   { type: "list", ordered?: boolean, items: string[] }
 *   { type: "quote", text }
 *   { type: "code", language?: string, text }        (shown as-is, never formatted)
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

function Block({ block }) {
  switch (block.type) {
    case "paragraph":
      return (
        <p>
          <Inline text={block.text} />
        </p>
      );

    // The panel title is an h2, so content headings start at h3.
    case "heading":
      return block.level === 3 ? (
        <h4>
          <Inline text={block.text} />
        </h4>
      ) : (
        <h3>
          <Inline text={block.text} />
        </h3>
      );

    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List>
          {(block.items ?? []).map((item, index) => (
            <li key={index}>
              <Inline text={item} />
            </li>
          ))}
        </List>
      );
    }

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
