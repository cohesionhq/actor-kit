// Transcript text: what the user said as words, and a whole transcript as
// text, for an agent picking up an actor session whose agent session it no longer has.

import type { ActorSessionMessage, ActorUserContent } from 'cohesion-ts';

/**
 * What the user said, as words: a response to a request no longer waiting
 * (its agent process ended) is handed over as text.
 */
export function describe(response: ActorUserContent): string {
	switch (response.kind) {
		case 'text':
			return response.text;
		case 'answers':
			return `My answers to your earlier questions: ${response.answers
				.map((answer) => [...answer.selected, ...(answer.other ? [answer.other] : [])].join(', '))
				.join('; ')}`;
		case 'permission':
			return `About your earlier request: ${response.decision === 'allow' || response.decision === 'allowForSession' ? 'go ahead' : 'no'}.${response.message ? ` ${response.message}` : ''}`;
		case 'plan':
			return response.approved
				? 'I approve your plan; go ahead.'
				: `I don't approve your plan.${response.feedback ? ` ${response.feedback}` : ''}`;
	}
}

/**
 * A transcript as text, oldest first. `speaker` names the agent ("Claude");
 * `toolName` shows a tool's name as the client does elsewhere.
 */
export function transcriptText(messages: ActorSessionMessage[], speaker: string, toolName: (name: string) => string = (name) => name): string {
	return messages
		.map(({ content }) => {
			if (content.sender === 'user') {
				return content.kind === 'text' ? `User: ${content.text}` : `User responded to a request (${content.kind}).`;
			}
			switch (content.kind) {
				case 'text':
					return `${speaker}: ${content.text}`;
				case 'toolUse':
					return `[${toolName(content.tool)} ${content.summary}]`;
				case 'question':
					return `${speaker} asked: ${content.questions.map((question) => question.question).join(' ')}`;
				case 'permission':
					return `${speaker} asked permission to use ${content.subject.kind === 'tool' ? toolName(content.subject.name) : content.subject.kind}.`;
				case 'plan':
					return `${speaker} proposed a plan:\n${content.plan}`;
			}
		})
		.join('\n\n');
}
