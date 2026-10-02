export function memoryDb() {
  const jobs = new Map(),
    items = new Map();
  return {
    async createJob(j) {
      jobs.set(j.id, structuredClone(j));
    },
    async getJob(id) {
      return structuredClone(jobs.get(id));
    },
    async listJobs() {
      return structuredClone([...jobs.values()]);
    },
    async updateJob(id, patch, runId) {
      const j = jobs.get(id);
      if (!j || (runId !== undefined && j.runId !== runId)) throw new Error("stale run");
      Object.assign(j, structuredClone(patch));
      return structuredClone(j);
    },
    async getItem(jobId, key) {
      return structuredClone(items.get(jobId + "/" + key));
    },
    async listItems(jobId) {
      return structuredClone([...items.values()].filter((i) => i.jobId === jobId));
    },
    async putItem(jobId, runId, item) {
      if (jobs.get(jobId)?.runId !== runId) throw new Error("stale run");
      const value = { ...structuredClone(item), jobId };
      items.set(jobId + "/" + item.key, value);
      return value;
    },
    async deleteJob(id) {
      jobs.delete(id);
      for (const [key, value] of items) if (value.jobId === id) items.delete(key);
    },
  };
}
