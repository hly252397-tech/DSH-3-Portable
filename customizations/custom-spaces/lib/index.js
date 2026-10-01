import z from '@deepseek-ai/schemastery';

export const name = 'dsh-custom-spaces';
export const MAX_SPACES = 5;
export const SPACES_SETTINGS_NAMESPACE = 'custom-spaces';

// rc.2 derives forms from live Config fields on Loader entries.
export const Config = z.object({
  spaces: z.array(z.object({
    name: z.string().default(''),
    url: z.string().default(''),
    enabled: z.boolean().default(true),
  })).max(MAX_SPACES).default([]).volatile(),
});

export function apply(ctx) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
}
