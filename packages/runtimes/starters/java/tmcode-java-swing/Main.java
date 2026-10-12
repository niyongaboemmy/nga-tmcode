import javax.swing.*;
import java.awt.*;

public class Main {
    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> {
            JFrame frame = new JFrame("Greeter");
            JTextField name = new JTextField(16);
            JLabel out = new JLabel("Type your name and press Greet");
            JButton greet = new JButton("Greet");
            greet.addActionListener(e -> out.setText("Hello, " + name.getText() + "!"));

            JPanel panel = new JPanel(new FlowLayout());
            panel.add(name);
            panel.add(greet);
            frame.add(panel, BorderLayout.NORTH);
            frame.add(out, BorderLayout.CENTER);
            frame.setSize(420, 140);
            frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
            frame.setVisible(true);
        });
    }
}
