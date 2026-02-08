from agents.base_agent import BaseAgent


class Orchestrator:
    """Run agents sequentially, accumulating results in a shared context.

    Later replaced by a DedalusRunner with tools — each agent.run()
    becomes a tool function, and the runner handles parallelism.
    """

    def __init__(self, agents: list[BaseAgent]) -> None:
        self._agents = agents

    async def run(self, prompt: str) -> dict:
        context: dict = {"prompt": prompt}
        for agent in self._agents:
            result = await agent.run(context)
            context.update(result)
        return context
