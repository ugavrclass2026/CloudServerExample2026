using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

// Talk to Gemini through your own cloud server (server.mjs). Put this on any object, set Server to your
// address (https://<your VM's IP>), press Play: the answer shows in the Console. Call Ask() from your own code
// for more turns; the session id keeps the conversation going, and the persona is used for its first turn.
public class ServerChat : MonoBehaviour
{
    public string server = "https://203.0.113.10";      // your VM's address, no slash at the end
    [TextArea(2, 6)]
    public string persona = "You are a friendly guide inside a VR app. Answer in one or two short spoken sentences. " +
                            "No lists, no markdown, no emoji.";
    public string firstQuestion = "Hi! Who are you?";

    string session = "";

    [Serializable] class Request { public string message; public string session; public string persona; }
    [Serializable] class Reply { public string reply; public string session; public string error; }

    IEnumerator Start()
    {
        yield return Ask(firstQuestion, answer => Debug.Log("Gemini: " + answer));
    }

    public IEnumerator Ask(string message, Action<string> onAnswer)
    {
        string json = JsonUtility.ToJson(new Request { message = message, session = session, persona = persona });
        using (var req = new UnityWebRequest(server + "/api/chat", "POST"))
        {
            req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            req.timeout = 30;
            yield return req.SendWebRequest();

            if (req.result != UnityWebRequest.Result.Success)
            {
                Debug.LogWarning($"Server: {req.error} {req.downloadHandler.text}");
                yield break;
            }
            var reply = JsonUtility.FromJson<Reply>(req.downloadHandler.text);
            session = reply.session;
            onAnswer(reply.reply);
        }
    }
}
