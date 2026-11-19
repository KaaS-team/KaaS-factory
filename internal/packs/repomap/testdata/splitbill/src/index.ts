import { renderReport } from "./bill/report";
import { splitWeighted } from "./bill/split";

export function main(): void {
  console.log(renderReport(10, 3));
  splitWeighted(10, [1, 2]);
}
