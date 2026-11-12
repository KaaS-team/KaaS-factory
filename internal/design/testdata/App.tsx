export function App({ items, on }) {
  return (
    <div data-oid="root" className="p-2 flex">
      <h1 data-oid="h">Hello</h1>
      <p data-oid="p">One</p>
      <em data-oid="e">Two</em>
      {on && <span data-oid="cond">x</span>}
      {items.map((i) => <li key={i} data-oid="item">{i}</li>)}
    </div>
  );
}
