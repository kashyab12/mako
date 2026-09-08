/** Native text with one finite arrival, including when an update interrupts it. */
export function ChangingLabel({ text }: { text: string }) {
  return <span key={text} className="changing-label">{text}</span>
}
