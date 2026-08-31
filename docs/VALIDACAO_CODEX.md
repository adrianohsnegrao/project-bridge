# Validação externa com Codex CLI

Esta evidência registra uma execução real do Project Bridge como servidor MCP externo. Ela não substitui os contract tests: comprova que um cliente de IA independente consegue descobrir e chamar as Tools públicas pela fronteira HTTP.

## Ambiente validado

- data: 31 de agosto de 2026;
- cliente: `codex-cli 0.150.0-alpha.8`;
- servidor: Project Bridge `0.2.0` durante a execução, promovido a `0.3.0` com esta documentação;
- transporte: Streamable HTTP;
- endpoint: `http://127.0.0.1:8010/mcp`;
- política do cliente: Tools de escrita exigem aprovação;
- escopos fornecidos: `projects:read`, `approvals:read` e `tasks:propose`.

> A execução original antecede a versão `0.6.0`. A partir dela, a fronteira HTTP exige Bearer token e os escopos vêm da credencial configurada no servidor, sem confiar em cabeçalhos de permissão enviados pelo cliente.

## Cenário

O cliente recebeu a instrução de usar exclusivamente o servidor `project_bridge`, executar primeiro `list_projects`, consultar o primeiro resultado com `get_project_context`, não usar shell e não modificar dados.

Trajetória observada:

```text
Codex CLI
  → project_bridge.list_projects({})
  ← Projeto Atlas
  → project_bridge.get_project_context({ project_id: "atlas" })
  ← contexto estruturado do projeto
  → resposta: Projeto Atlas, em risco, 4 tarefas e 2 impedimentos
```

As duas chamadas terminaram com `status: success`. A trilha de auditoria do servidor registrou o cliente `codex-external-validation`, as Tools executadas, seus alvos e a duração.

## Resultado

```text
- Nome: Projeto Atlas
- Estado: Em risco (at_risk)
- Tarefas: 4
- Impedimentos: 2
```

Nenhuma Tool mutável foi chamada. O resultado veio de `structuredContent`, sem acesso direto ao SQLite e sem uso do shell pelo cliente.

## Como reproduzir

1. Defina `PROJECT_BRIDGE_HTTP_CREDENTIALS` no processo do servidor conforme o README.
2. Defina `PROJECT_BRIDGE_HTTP_TOKEN` no processo do Codex com o mesmo token.
3. Execute `pnpm dev` na raiz.
4. Confirme `http://127.0.0.1:8010/api/health`.
5. Abra o repositório como projeto confiável no Codex.
6. Reinicie o cliente para carregar [`.codex/config.toml`](../.codex/config.toml).
7. Use `/mcp` no cliente interativo ou `codex mcp list` na CLI para conferir o servidor.
8. Peça ao cliente para listar os projetos usando somente `project_bridge`.

O formato de configuração e os recursos suportados estão descritos na [documentação oficial de MCP no Codex](https://developers.openai.com/codex/mcp/).
