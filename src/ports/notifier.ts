// How a person is told the factory needs them or finished. Only these two kinds exist, so a
// channel cannot grow into a stream of progress noise.

export type NoticeKind = "needs-you" | "done";
export const NOTICE_KINDS: readonly NoticeKind[] = ["needs-you", "done"];

export interface Notice {
  readonly kind: NoticeKind;
  readonly title: string;
  readonly body: string;
  // A path on the plane the notice opens, never an absolute URL.
  readonly url: string;
}

export interface NotifierPort {
  // Resolves to how many devices accepted it.
  notify(notice: Notice): Promise<number>;
}
