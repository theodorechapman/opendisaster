from abc import ABC, abstractmethod


class BaseAgent(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    async def run(self, context: dict) -> dict:
        """Take a shared context dict, perform one task, return results to merge back."""
        ...
