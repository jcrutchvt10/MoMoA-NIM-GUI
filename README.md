An experimemtal extensible “Mixture of Mixture of Agents” agent implementation, capable of solving problems in a variety of domains depending on the mixture (of mixture) of agents included. Tuned to complete long-running, complex, SDLC tasks.

Project Home Page:
https://labs.google/code/experiments/momoa

Code Home:
https://github.com/retomeier/momoa

Maintained by:
Reto Meier
 
## Quick Start Guide
Create a `.env` file containing a Gemini API key:
```
GEMINI_API_KEY
```

Add an `.agentignore` file in your project folder. It uses the same rules as a `.gitignore` file.

Server:
```
npm install
npm run dev
```

Client:
```
python3 client-cli/python_cli.py "Create a Markdown describing the color blue." -d ~/Code/my_project -o ~/Code/my_project/agent_output
```


## How it works
Server:
1. The Orchestrator takes a user prompt and has instructions to break up the work and start Work Phases to complete each task.
2. When the Orchestrator creates a new Work Phase to complete a task, we ask the LLM to:
2.1 Choose the most suitable “Work Phase Room” (Eg. Engineering, Documentation, Planning, …).
2.2 Choose two “Expert Personas” (Eg. Senior Engineer, Principal Researcher, Tech Writer, …) to collaborate.
3. The Experts within each Work Phase take turns, collaborating on the problem via tool use and discussion until they agree the task is complete and they provide a report to the Orchestrator. 
4. The Orchestrator reviews the Work Phase report and continues creating new Work Phases. It’s instructed to start a Validation Work Phase when it thinks it’s finished, and to keep going until validation passes.
5. When Validation passes, the Orchestrator summarizes the project work and finishes.
6. The harness provides the summary and a diff of all the file changes to the client.

Client:
1. Connects with the Server and sends the initial request parameters.
2. Sends all the files in the source folder that aren't excluded by the .agentignore file.
3. Outputs progress updates received from the Server.
4. Handles human-in-the-loop requests from the Server.
5. Saves the worklogs showing what the agent is doing in real time.
6. Saves the results from the agent (file changes and project summary).

## License
This project is licensed under the Apache 2 License - see the [license.md](LICENSE) file for details.