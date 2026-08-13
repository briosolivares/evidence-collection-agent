import { z } from 'zod';

import type { ToolDef } from '../registry.js';
import { actByRef, requireBrowser } from '../shared/browser.js';

const fieldSchema = z.strictObject({
  ref: z
    .string()
    .min(1)
    .describe('Editable element ref from the latest inspect_page result'),
  value: z
    .enum(['username', 'password'])
    .describe('Which stored value to fill; the secret itself is never exposed'),
});

const fillCredentialsInputSchema = z
  .strictObject({
    fields: z
      .array(fieldSchema)
      .min(1)
      .max(2)
      .describe('Fields to fill, at most one per value kind'),
    submit_ref: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Button ref clicked immediately after filling; required whenever a password field is filled',
      ),
  })
  .superRefine((input, ctx) => {
    const values = input.fields.map((field) => field.value);
    if (new Set(values).size !== values.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'each value kind ("username", "password") may appear at most once',
      });
    }
    // Password fill-and-submit is atomic: no inspection or screenshot may
    // observe the DOM between the password landing in a field and the form
    // submitting, so no recorded artifact can capture it.
    if (values.includes('password') && input.submit_ref === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['submit_ref'],
        message: 'submit_ref is required when filling a password field',
      });
    }
  });

export type FillCredentialsInput = z.infer<typeof fillCredentialsInputSchema>;

/**
 * `fill_credentials` — fill login fields with stored credentials the model
 * can use but never see.
 *
 * The model supplies *where* (element refs plus which value kind each ref
 * receives); the executor supplies *what*, looked up by the hostname of the
 * page the browser is actually on — never from model input — so credentials
 * can only ever be filled into their own site. The result carries metadata
 * only. A hostname with no stored credentials throws the structured
 * "no credentials" error, which doubles as the model's discovery mechanism
 * and its cue to hand off to the user.
 */
export const fillCredentialsTool: ToolDef<FillCredentialsInput> = {
  name: 'fill_credentials',
  description:
    'Fills login form fields with stored credentials for the site currently ' +
    'in the browser, by ref from inspect_page. Credentials stay hidden: name ' +
    'which value ("username" or "password") goes in which ref. Filling a ' +
    'password requires submit_ref, which is clicked in the same call. Errors ' +
    'if no credentials are stored for the current site.',
  inputSchema: fillCredentialsInputSchema,
  readOnly: false,
  async execute(input, ctx) {
    const browser = requireBrowser(ctx);
    const hostname = new URL(browser.currentUrl()).hostname;

    const credential = (await ctx.credentials?.lookup(hostname)) ?? null;
    if (credential === null) {
      throw new Error(
        `No credentials stored for "${hostname}". Ask the user to complete login manually.`,
      );
    }

    for (const field of input.fields) {
      await actByRef(field.ref, () =>
        browser.type(field.ref, credential[field.value]),
      );
    }

    const submitRef = input.submit_ref;
    if (submitRef !== undefined) {
      await actByRef(submitRef, () => browser.click(submitRef));
    }

    return {
      filled: input.fields.map((field) => field.value),
      submitted: submitRef !== undefined,
      url: browser.currentUrl(),
    };
  },
};
