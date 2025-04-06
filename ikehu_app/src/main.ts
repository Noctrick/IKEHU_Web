import { generateClient } from "aws-amplify/data";
import type { Schema } from "../amplify/data/resource";
import './style.css';
import { Amplify } from 'aws-amplify';
import outputs from '../amplify_outputs.json';

Amplify.configure(outputs);


const client = generateClient<Schema>();

document.addEventListener("DOMContentLoaded", function () {
    const todos: Array<Schema["Todo"]["type"]> = [];
    const todoList = document.getElementById("todoList") as HTMLUListElement;
    const addTodoButton = document.getElementById("addTodo") as HTMLButtonElement;

    addTodoButton.addEventListener("click", createTodo);

    function updateUI() {
        todoList.innerHTML = '';
        todos.forEach(todo => {
            const li = document.createElement('li');
            li.textContent = todo.content ?? '';
            todoList.appendChild(li);
        });
    }

    function createTodo() {
      console.log('createTodo');
      const content = window.prompt("Todo content");
      if (content) {
          client.models.Todo.create({ content }).then(response => {
              if (response.data && !response.errors) {
                  todos.push(response.data);
                  updateUI();
              } else {
                  console.error('Error creating todo:', response.errors);
                  alert('Failed to create todo.');
              }
          }).catch(error => {
              console.error('Network or other error:', error);
              alert('Failed to create todo due to a network or other error.');
          });
      }
  }


    client.models.Todo.observeQuery().subscribe({
        next: (data) => {
            todos.splice(0, todos.length, ...data.items);
            updateUI();
        }
    });
});