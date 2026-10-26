// SPDX-License-Identifier: LicenseRef-KaaS-EE
// A SAML 2.0 response is trusted only when the pinned IdP certificate signed the very element the
// claims are read from, so a second, unsigned assertion wrapped around a signed one is refused.
import { createHash, verify, X509Certificate } from "node:crypto";
import { attr, canonicalize, descendants, elements, isNs, parseXml, textOf, type XmlElement } from "./xml";

const DS = "http://www.w3.org/2000/09/xmldsig#";
const SAML = "urn:oasis:names:tc:SAML:2.0:assertion";
const PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const SKEW_MS = 60_000;

export interface SamlOptions {
  readonly cert: string; // PEM of the IdP's signing certificate
  readonly audience: string; // our SP entity id
  readonly issuer?: string;
  readonly recipient?: string; // our ACS URL
  readonly inResponseTo?: string; // the AuthnRequest id we sent, when we sent one
  readonly now?: Date;
}

export interface SamlIdentity {
  readonly login: string;
  readonly assertionId: string;
  readonly notOnOrAfter: number;
}

const one = (els: XmlElement[], what: string): XmlElement => {
  if (els.length !== 1) throw new Error(`expected one ${what}, found ${els.length}`);
  return els[0]!;
};
const child = (el: XmlElement, ns: string, local: string) => elements(el).filter((c) => isNs(c, ns, local));

// Checks the enveloped signature on `signed` and returns nothing; any doubt throws.
function checkSignature(signed: XmlElement, root: XmlElement, cert: string): void {
  const sig = one(child(signed, DS, "Signature"), "Signature");
  const info = one(child(sig, DS, "SignedInfo"), "SignedInfo");
  const alg = (el: XmlElement[], want: string, what: string) => {
    if (attr(one(el, what), "Algorithm") !== want) throw new Error(`${what} must be ${want}`);
  };
  alg(child(info, DS, "CanonicalizationMethod"), EXC_C14N, "CanonicalizationMethod");
  alg(child(info, DS, "SignatureMethod"), RSA_SHA256, "SignatureMethod");
  const ref = one(child(info, DS, "Reference"), "Reference");
  const id = attr(signed, "ID") ?? "";
  if (!id || attr(ref, "URI") !== `#${id}`) throw new Error("the signature does not reference the signed element");
  // Two elements with one ID let an attacker point the reference at a copy.
  if ([...descendants(root)].filter((e) => attr(e, "ID") === id).length !== 1) throw new Error("duplicate ID");
  let prefixes: string[] = [];
  for (const t of child(one(child(ref, DS, "Transforms"), "Transforms"), DS, "Transform")) {
    const a = attr(t, "Algorithm");
    if (a !== ENVELOPED && a !== EXC_C14N) throw new Error(`transform ${a} is not allowed`);
    const list = elements(t).find((e) => e.name.endsWith("InclusiveNamespaces"));
    if (list) prefixes = (attr(list, "PrefixList") ?? "").split(/\s+/).filter(Boolean);
  }
  alg(child(ref, DS, "DigestMethod"), SHA256, "DigestMethod");
  const digest = createHash("sha256").update(canonicalize(signed, sig, prefixes)).digest("base64");
  if (digest !== textOf(one(child(ref, DS, "DigestValue"), "DigestValue")).replace(/\s/g, ""))
    throw new Error("digest mismatch: the signed element was changed");
  const value = Buffer.from(textOf(one(child(sig, DS, "SignatureValue"), "SignatureValue")).replace(/\s/g, ""), "base64");
  const key = new X509Certificate(cert).publicKey;
  if (!verify("sha256", Buffer.from(canonicalize(info)), key, value)) throw new Error("bad signature");
}

const time = (v: string | undefined) => (v === undefined ? undefined : Date.parse(v));

export function verifySamlResponse(xml: string, opts: SamlOptions): SamlIdentity {
  const now = (opts.now ?? new Date()).getTime();
  const root = parseXml(xml);
  if (!isNs(root, PROTOCOL, "Response")) throw new Error("not a SAML Response");
  const all = [...descendants(root)];
  if (all.some((e) => e.name.endsWith("EncryptedAssertion"))) throw new Error("encrypted assertions are not supported");
  const assertion = one(all.filter((e) => isNs(e, SAML, "Assertion")), "Assertion");
  if (assertion.parent !== root) throw new Error("the assertion must sit directly in the Response");
  // Either the assertion or the whole response may carry the signature.
  const signed = child(assertion, DS, "Signature").length ? assertion : root;
  checkSignature(signed, root, opts.cert);

  const status = all.find((e) => isNs(e, PROTOCOL, "StatusCode"));
  if (attr(status ?? root, "Value") !== "urn:oasis:names:tc:SAML:2.0:status:Success") throw new Error("IdP refused");
  const issuer = textOf(one(child(assertion, SAML, "Issuer"), "Issuer")).trim();
  if (opts.issuer && issuer !== opts.issuer) throw new Error(`issuer ${issuer} is not trusted`);
  const conditions = one(child(assertion, SAML, "Conditions"), "Conditions");
  const before = time(attr(conditions, "NotBefore"));
  const until = time(attr(conditions, "NotOnOrAfter"));
  if (until === undefined || Number.isNaN(until)) throw new Error("the assertion has no expiry");
  if ((before !== undefined && now + SKEW_MS < before) || now - SKEW_MS >= until) throw new Error("assertion expired");
  const audiences = [...descendants(conditions)].filter((e) => isNs(e, SAML, "Audience")).map((e) => textOf(e).trim());
  if (!audiences.includes(opts.audience)) throw new Error("the assertion is for another service");
  const subject = one(child(assertion, SAML, "Subject"), "Subject");
  for (const data of [...descendants(subject)].filter((e) => isNs(e, SAML, "SubjectConfirmationData"))) {
    const exp = time(attr(data, "NotOnOrAfter"));
    if (exp !== undefined && now - SKEW_MS >= exp) throw new Error("subject confirmation expired");
    if (opts.recipient && attr(data, "Recipient") && attr(data, "Recipient") !== opts.recipient)
      throw new Error("the assertion was sent to another address");
    const irt = attr(data, "InResponseTo") ?? attr(root, "InResponseTo");
    if (opts.inResponseTo && irt !== opts.inResponseTo) throw new Error("the response answers another request");
  }
  const login = textOf(one(child(subject, SAML, "NameID"), "NameID")).trim().toLowerCase();
  // An email can never be a GitHub login, so SSO and GitHub members cannot collide.
  if (!/^[^@\s]+@[^@\s]+$/.test(login)) throw new Error("the NameID must be an email address");
  return { login, assertionId: attr(assertion, "ID")!, notOnOrAfter: until };
}
