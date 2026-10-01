package com.example.a2a;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestClient;

@SpringBootApplication
@RestController
public class Agent2AgentApp {

    // The message both agents speak
    record Message(String from, String to, String content) {}

    // ponytail: both agents live in one app on port 8080; split into two apps when they need to scale separately
    private final RestClient client = RestClient.create("http://localhost:8080");

    public static void main(String[] args) {
        SpringApplication.run(Agent2AgentApp.class, args);
    }

    // Agent A (Writer): gets the task, asks Agent B to analyze the text, then writes the final report
    @GetMapping("/agent-a/task")
    String agentA(@RequestParam String text) {
        var request = new Message("AgentA", "AgentB", text.strip());
        System.out.println("A -> B: " + request);

        var reply = client.post().uri("/agent-b/inbox").body(request).retrieve().body(Message.class);
        System.out.println("B -> A: " + reply);

        return "AgentA report: \"%s\" has %s".formatted(request.content(), reply.content());
    }

    // Agent B (Analyzer): receives a message, does its part of the work, replies to the sender
    @PostMapping("/agent-b/inbox")
    Message agentB(@RequestBody Message msg) {
        var text = msg.content();
        int words = text.isBlank() ? 0 : text.split("\\s+").length;
        return new Message("AgentB", msg.from(), words + " words and " + text.length() + " characters");
    }
}
