export const branchAlias = (branch: string): string => branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const branchOrigin = (template: string, branch: string): string => template.replace("*", branchAlias(branch));
